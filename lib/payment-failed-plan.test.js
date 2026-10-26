'use strict';
/**
 * payment.failed must use the same plan check as the grant path.
 * Another Whop product must not mark a Twic user past_due or send email.
 */
const assert = require('assert');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const jwt = require('jsonwebtoken');
const { Webhook } = require('standardwebhooks');

const dbFile = path.join(os.tmpdir(), `wic-payfailed-${process.pid}.db`);
for (const extra of [dbFile, dbFile + '-wal', dbFile + '-shm']) {
  try { fs.unlinkSync(extra); } catch (e) {}
}

const WEBHOOK_SECRET = 'whsec_' + Buffer.from('0123456789abcdef0123456789abcdef').toString('base64');
const PLAN = 'plan_W9vAA0xyptzgt';

process.env.NODE_ENV = 'test';
process.env.WIC_DB_PATH = dbFile;
process.env.JWT_SECRET = 'unit-test-jwt-secret-at-least-32-chars';
process.env.ADMIN_PASSWORD = 'unit-test-admin-password';
process.env.TESTER_INVITE_TOKEN = 'unit-test-invite-token-32chars!!';
process.env.XAI_API_KEY = '';
process.env.RESEND_API_KEY = '';
process.env.WHOP_CHECKOUT_URL_MONTHLY = 'https://whop.com/checkout/test-plan';
process.env.WHOP_CHECKOUT_URL_YEARLY = '';
process.env.WHOP_WEBHOOK_SECRET = WEBHOOK_SECRET;
process.env.WHOP_PLAN_IDS = PLAN;

const { app, db } = require('../server');
const wh = new Webhook(WEBHOOK_SECRET);

const captured = [];
const origLog = console.log;
console.log = (...args) => {
  const line = args.map((a) => (typeof a === 'string' ? a : '')).join(' ');
  captured.push(line);
  origLog(...args);
};

function listen() {
  return new Promise((resolve) => {
    const server = http.createServer(app);
    server.listen(0, '127.0.0.1', () => {
      resolve({ server, port: server.address().port });
    });
  });
}

function request(port, { method, path: urlPath, headers, body }) {
  return new Promise((resolve, reject) => {
    const payload = body == null ? null : Buffer.from(typeof body === 'string' ? body : body);
    const req = http.request({
      hostname: '127.0.0.1',
      port,
      method: method || 'POST',
      path: urlPath,
      headers: {
        ...(payload ? { 'Content-Length': payload.length } : {}),
        ...headers,
      },
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = raw ? JSON.parse(raw) : null; } catch (e) {}
        resolve({ status: res.statusCode, json, raw });
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

let msgN = 0;
function postWebhook(port, event) {
  const id = 'msg_payfailed_' + (++msgN);
  const payload = JSON.stringify(event);
  const timestamp = new Date();
  const signature = wh.sign(id, timestamp, payload);
  return request(port, {
    method: 'POST',
    path: '/api/whop-webhook',
    headers: {
      'Content-Type': 'application/json',
      'webhook-id': id,
      'webhook-timestamp': String(Math.floor(timestamp.getTime() / 1000)),
      'webhook-signature': signature,
    },
    body: payload,
  });
}

function userRow(email) {
  return db.prepare('SELECT * FROM users WHERE email = ?').get(email);
}

function insertUser(email, fields) {
  db.prepare(`
    INSERT INTO users (email, status, access_granted, manual_free)
    VALUES (?, ?, ?, ?)
  `).run(
    email,
    fields.status || 'active',
    fields.access_granted == null ? 1 : fields.access_granted,
    fields.manual_free ? 1 : 0
  );
}

function meStatus(port, email) {
  const row = userRow(email);
  const token = jwt.sign({ email, id: row.id }, process.env.JWT_SECRET, { expiresIn: '1h' });
  return request(port, {
    method: 'GET',
    path: '/api/me',
    headers: { Authorization: 'Bearer ' + token },
  });
}

function failedPayment(email, planId) {
  const data = {
    id: 'pay_' + email,
    user: { email },
  };
  if (planId) data.plan = { id: planId };
  return { type: 'payment.failed', data };
}

async function main() {
  const { server, port } = await listen();
  try {
    insertUser('other-active@example.com', { status: 'active', access_granted: 1 });
    const beforeOther = captured.length;
    const other = await postWebhook(port, failedPayment('other-active@example.com', 'plan_other_product'));
    assert.strictEqual(other.status, 200);
    const otherRow = userRow('other-active@example.com');
    assert.strictEqual(otherRow.status, 'active', 'another product does not mark an active user past_due');
    assert.strictEqual(otherRow.access_granted, 1, 'another product does not change access_granted');
    const otherMe = await meStatus(port, 'other-active@example.com');
    assert.strictEqual(otherMe.status, 200, 'another product leaves /api/me 200 for an active user');
    const otherLog = captured.slice(beforeOther).join('\n');
    assert.strictEqual(/payment-failed notice sent/.test(otherLog), false, 'another product sends no payment-failed email');
    assert.strictEqual(/marked other-active@example.com past_due/.test(otherLog), false);

    insertUser('other-free@example.com', { status: 'active', access_granted: 1, manual_free: 1 });
    const beforeFree = captured.length;
    const foreignFree = await postWebhook(port, failedPayment('other-free@example.com', 'plan_other_product'));
    assert.strictEqual(foreignFree.status, 200);
    const freeRow = userRow('other-free@example.com');
    assert.strictEqual(freeRow.status, 'active', 'another product does not change a manual_free user');
    assert.strictEqual(freeRow.manual_free, 1);
    assert.strictEqual(freeRow.access_granted, 1);
    const freeMe = await meStatus(port, 'other-free@example.com');
    assert.strictEqual(freeMe.status, 200, 'another product leaves /api/me 200 for manual_free');
    const freeLog = captured.slice(beforeFree).join('\n');
    assert.strictEqual(/payment-failed notice sent/.test(freeLog), false, 'another product sends no email to manual_free');

    insertUser('twic-plan@example.com', { status: 'active', access_granted: 1 });
    const beforeTwic = captured.length;
    const twic = await postWebhook(port, failedPayment('twic-plan@example.com', PLAN));
    assert.strictEqual(twic.status, 200);
    const twicRow = userRow('twic-plan@example.com');
    assert.strictEqual(twicRow.status, 'past_due', 'a Twic-plan failure still sets past_due');
    assert.strictEqual(twicRow.access_granted, 1, 'a Twic-plan failure still leaves access_granted unchanged');
    const twicLog = captured.slice(beforeTwic).join('\n');
    assert.ok(/marked twic-plan@example.com past_due \(access kept until Whop deactivates membership\)/.test(twicLog), twicLog);
    assert.ok(/payment-failed notice sent to twic-plan@example.com/.test(twicLog), twicLog);
    assert.ok(/\[WHOP EMAIL to twic-plan@example.com\]/.test(twicLog), twicLog);
    const twicMe = await meStatus(port, 'twic-plan@example.com');
    assert.strictEqual(twicMe.status, 403, 'a Twic-plan failure still cuts off /api/me');

    insertUser('no-plan@example.com', { status: 'active', access_granted: 1 });
    const noPlan = await postWebhook(port, failedPayment('no-plan@example.com'));
    assert.strictEqual(noPlan.status, 200);
    const noPlanRow = userRow('no-plan@example.com');
    assert.strictEqual(noPlanRow.status, 'past_due', 'a missing plan id still fails the same way the grant path allows it');
    assert.strictEqual(noPlanRow.access_granted, 1);

    console.log = origLog;
    console.log('lib/payment-failed-plan.test.js passed');
  } finally {
    console.log = origLog;
    await new Promise((resolve) => server.close(resolve));
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
