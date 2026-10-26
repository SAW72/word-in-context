'use strict';
/**
 * Free forever (manual_free=1) users get no billing, trial or past due mail
 * and are never downgraded by Whop or Stripe events or a tester invite.
 * Controls show paid users, 7 day Whop trials and 14 day testers unchanged.
 */
const assert = require('assert');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const jwt = require('jsonwebtoken');
const { Webhook } = require('standardwebhooks');

const dbFile = path.join(os.tmpdir(), `wic-manualfree-${process.pid}.db`);
function cleanDb() {
  for (const extra of [dbFile, dbFile + '-wal', dbFile + '-shm']) {
    try { fs.unlinkSync(extra); } catch (e) {}
  }
}
cleanDb();

const WEBHOOK_SECRET = 'whsec_' + Buffer.from('fedcba9876543210fedcba9876543210').toString('base64');
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
process.env.STRIPE_SECRET_KEY = 'sk_test_unit_only_not_a_real_key';
process.env.STRIPE_WEBHOOK_SECRET = 'whsec_unit_test_stripe_secret';
process.env.TRIAL_DAYS = '7';
process.env.TESTER_TRIAL_DAYS = '14';

const { app, db } = require('../server');
const wh = new Webhook(WEBHOOK_SECRET);
const stripeLib = require('stripe')(process.env.STRIPE_SECRET_KEY);

const captured = [];
const origLog = console.log;
console.log = (...args) => {
  captured.push(args.map((a) => (typeof a === 'string' ? a : '')).join(' '));
  origLog(...args);
};

function listen() {
  return new Promise((resolve) => {
    const server = http.createServer(app);
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

function request(port, { method, path: urlPath, headers, body }) {
  return new Promise((resolve, reject) => {
    const payload = body == null ? null : Buffer.from(body);
    const req = http.request({
      hostname: '127.0.0.1',
      port,
      method,
      path: urlPath,
      headers: { ...(payload ? { 'Content-Length': payload.length } : {}), ...headers },
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, raw: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

let msgN = 0;
function postWebhook(port, event) {
  const id = 'msg_manualfree_' + (++msgN);
  const payload = JSON.stringify(event);
  const timestamp = new Date();
  return request(port, {
    method: 'POST',
    path: '/api/whop-webhook',
    headers: {
      'Content-Type': 'application/json',
      'webhook-id': id,
      'webhook-timestamp': String(Math.floor(timestamp.getTime() / 1000)),
      'webhook-signature': wh.sign(id, timestamp, payload),
    },
    body: payload,
  });
}

function postStripe(port, event) {
  const payload = JSON.stringify(event);
  const header = stripeLib.webhooks.generateTestHeaderString({ payload, secret: process.env.STRIPE_WEBHOOK_SECRET });
  return request(port, {
    method: 'POST',
    path: '/api/stripe-webhook',
    headers: { 'Content-Type': 'application/json', 'stripe-signature': header },
    body: payload,
  });
}

function adminToken() {
  return jwt.sign({ role: 'admin' }, process.env.JWT_SECRET, { expiresIn: '1h' });
}

function createTester(port, email) {
  return request(port, {
    method: 'POST',
    path: '/api/admin/create-special-tester',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + adminToken() },
    body: JSON.stringify({ email }),
  });
}

function userRow(email) {
  return db.prepare('SELECT status, access_granted, manual_free, trial_end, whop_membership_id FROM users WHERE email = ?').get(email);
}

function insertUser(email, { status, manualFree, stripeCustomer }) {
  db.prepare('INSERT INTO users (email, status, access_granted, manual_free, stripe_customer_id) VALUES (?, ?, 1, ?, ?)')
    .run(email, status, manualFree ? 1 : 0, stripeCustomer || null);
}

function meStatus(port, email) {
  const token = jwt.sign({ email }, process.env.JWT_SECRET, { expiresIn: '1h' });
  return request(port, { method: 'GET', path: '/api/me', headers: { Authorization: 'Bearer ' + token } });
}

function mailTo(lines, email) {
  return lines.filter((l) => l.includes(`[WHOP EMAIL to ${email}]`) || l.includes(`[MAGIC LINK for ${email}]`));
}

async function expectUntouched(port, email, event, label, send) {
  insertUser(email, { status: 'free', manualFree: true, stripeCustomer: 'cus_' + email });
  const before = userRow(email);
  const from = captured.length;
  const res = await (send || postWebhook)(port, event);
  assert.strictEqual(res.status, 200, `${label}: webhook 200`);
  assert.deepStrictEqual(userRow(email), before, `${label}: manual_free row unchanged`);
  const lines = captured.slice(from);
  assert.deepStrictEqual(mailTo(lines, email), [], `${label}: no email to manual_free user`);
  assert.strictEqual(lines.some((l) => l.includes(`marked ${email} past_due`)), false, `${label}: not marked past_due`);
  const me = await meStatus(port, email);
  assert.strictEqual(me.status, 200, `${label}: manual_free keeps /api/me 200`);
  assert.strictEqual(JSON.parse(me.raw).status, 'free', `${label}: /api/me still shows free`);
}

const { isManualFree } = require('./security');
assert.strictEqual(isManualFree({ manual_free: 1 }), true);
assert.strictEqual(isManualFree({ manual_free: 0 }), false);
assert.strictEqual(isManualFree(null), false);
assert.strictEqual(isManualFree(undefined), false);
assert.strictEqual(isManualFree({ manual_free: '1' }), true);
assert.strictEqual(isManualFree({ manual_free: 2 }), false);
assert.strictEqual(isManualFree({ manual_free: '' }), false);
assert.strictEqual(isManualFree({ status: 'free', manual_free: 0 }), false);

function insertRaw(email, { status, access, manualFree, trialEnd }) {
  db.prepare('INSERT INTO users (email, status, access_granted, manual_free, trial_end) VALUES (?, ?, ?, ?, ?)')
    .run(email, status, access, manualFree, trialEnd);
}

function setAccess(port, email, body) {
  return request(port, {
    method: 'POST',
    path: '/api/admin/set-access',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + adminToken() },
    body: JSON.stringify({ email, ...body }),
  });
}

async function grantKeepsManualFreeRow(port) {
  // (a) A Whop grant on a manual_free row applies access but keeps status and trial_end.
  const grants = [
    ['membership.activated active', (e) => ({ type: 'membership.activated', data: { id: 'mem_ga1', status: 'active', plan: { id: PLAN }, user: { email: e }, renewal_period_end: '2026-12-01T00:00:00Z' } })],
    ['membership.went_valid trialing', (e) => ({ type: 'membership.went_valid', data: { id: 'mem_ga2', status: 'trialing', plan: { id: PLAN }, user: { email: e }, renewal_period_end: '2026-12-01T00:00:00Z' } })],
    ['membership.created active', (e) => ({ type: 'membership.created', data: { id: 'mem_ga3', status: 'active', plan: { id: PLAN }, user: { email: e } } })],
    ['payment.succeeded active membership', (e) => ({ type: 'payment.succeeded', data: { id: 'pay_ga4', membership: { id: 'mem_ga4', status: 'active', plan: { id: PLAN }, user: { email: e } } } })],
  ];
  let i = 0;
  for (const [label, make] of grants) {
    for (const trialEnd of [null, '2030-01-01T00:00:00.000Z']) {
      const email = `mf-grant-${++i}@example.com`;
      insertRaw(email, { status: 'free', access: 0, manualFree: 1, trialEnd });
      const from = captured.length;
      const res = await postWebhook(port, make(email));
      assert.strictEqual(res.status, 200, `${label}: webhook 200`);
      const row = userRow(email);
      assert.strictEqual(row.access_granted, 1, `${label}: grant applies access to manual_free row`);
      assert.strictEqual(row.status, 'free', `${label}: manual_free status unchanged on grant`);
      assert.strictEqual(row.trial_end, trialEnd, `${label}: manual_free trial_end unchanged on grant`);
      assert.strictEqual(row.manual_free, 1);
      assert.deepStrictEqual(mailTo(captured.slice(from), email), [], `${label}: no mail to manual_free on grant`);
    }
  }
}

async function grantControlFreeNotManual(port) {
  // (b) status free with manual_free 0 gets the normal grant: status and trial_end from Whop, login email.
  const email = 'free-not-manual@example.com';
  insertRaw(email, { status: 'free', access: 0, manualFree: 0, trialEnd: null });
  const from = captured.length;
  const res = await postWebhook(port, { type: 'membership.activated', data: { id: 'mem_gb', status: 'trialing', plan: { id: PLAN }, user: { email }, renewal_period_end: '2026-12-01T00:00:00Z' } });
  assert.strictEqual(res.status, 200);
  const row = userRow(email);
  assert.strictEqual(row.status, 'trialing', 'free but not manual_free gets grant status');
  assert.strictEqual(row.trial_end, '2026-12-01T00:00:00Z', 'free but not manual_free gets grant trial_end');
  assert.strictEqual(row.access_granted, 1);
  assert.strictEqual(mailTo(captured.slice(from), email).length, 1, 'free but not manual_free gets the login email');
}

async function clearManualFreeAfterGrant(port) {
  // (c) Clearing manual_free after a grant leaves a working account and sends nothing.
  const email = 'mf-cleared@example.com';
  insertRaw(email, { status: 'free', access: 1, manualFree: 1, trialEnd: null });
  const from = captured.length;
  await postWebhook(port, { type: 'membership.activated', data: { id: 'mem_gc', status: 'trialing', plan: { id: PLAN }, user: { email }, renewal_period_end: '2020-01-01T00:00:00Z' } });
  const cleared = await setAccess(port, email, { access_granted: true, manual_free: false });
  assert.strictEqual(cleared.status, 200);
  assert.strictEqual(userRow(email).manual_free, 0);
  const me = await meStatus(port, email);
  assert.ok(me.status !== 401 && me.status !== 403, `cleared manual_free gets no 401 or 403 (got ${me.status})`);
  assert.strictEqual(me.status, 200);
  assert.strictEqual(JSON.parse(me.raw).status, 'free', 'cleared manual_free keeps status free, not an old trial');
  const lines = captured.slice(from);
  assert.deepStrictEqual(mailTo(lines, email), [], 'no mail on grant or clear');
  assert.strictEqual(lines.some((l) => l.includes(`trial-ending reminder sent to ${email}`)), false, 'no trial ending email');
}

async function main() {
  const { server, port } = await listen();
  try {
    await expectUntouched(port, 'mf-failed-twic@example.com',
      { type: 'payment.failed', data: { id: 'pay_mf1', user: { email: 'mf-failed-twic@example.com' }, plan: { id: PLAN } } },
      'payment.failed Twic plan');
    await expectUntouched(port, 'mf-failed-noplan@example.com',
      { type: 'payment.failed', data: { id: 'pay_mf2', user: { email: 'mf-failed-noplan@example.com' } } },
      'payment.failed no plan id');
    for (const type of ['membership.deactivated', 'membership.went_invalid', 'membership.canceled']) {
      const email = `mf-${type.split('.')[1]}@example.com`;
      await expectUntouched(port, email,
        { type, data: { id: 'mem_' + type, status: 'active', plan: { id: PLAN }, user: { email } } },
        type);
    }
    for (const status of ['past_due', 'expired', 'canceled', 'unresolved']) {
      const email = `mf-activated-${status}@example.com`;
      await expectUntouched(port, email,
        { type: 'membership.activated', data: { id: 'mem_act_' + status, status, plan: { id: PLAN }, user: { email } } },
        `membership.activated status ${status}`);
    }
    await expectUntouched(port, 'mf-trial-ending@example.com',
      { type: 'membership.trial_ending_soon', data: { id: 'mem_mf_te', status: 'trialing', plan: { id: PLAN }, user: { email: 'mf-trial-ending@example.com' }, renewal_period_end: '2026-11-02T00:00:00Z' } },
      'membership.trial_ending_soon');
    await expectUntouched(port, 'mf-tester@example.com', 'mf-tester@example.com',
      '14 day tester invite for a manual_free user', createTester);
    await expectUntouched(port, 'mf-stripe-checkout@example.com',
      { id: 'evt_mf1', type: 'checkout.session.completed', data: { object: { id: 'cs_mf1', customer: 'cus_mf-stripe-checkout@example.com', customer_email: 'mf-stripe-checkout@example.com', metadata: { email: 'mf-stripe-checkout@example.com' }, subscription: 'sub_mf1' } } },
      'stripe checkout.session.completed', postStripe);
    for (const [type, status] of [['customer.subscription.updated', 'past_due'], ['customer.subscription.updated', 'unpaid'], ['customer.subscription.deleted', 'canceled']]) {
      const email = `mf-stripe-${status}@example.com`;
      await expectUntouched(port, email,
        { id: 'evt_' + status, type, data: { object: { id: 'sub_' + status, customer: 'cus_' + email, status } } },
        `stripe ${type} ${status}`, postStripe);
    }
    await expectUntouched(port, 'mf-succeeded-expired@example.com',
      { type: 'payment.succeeded', data: { id: 'pay_mf3', membership: { id: 'mem_mf3', status: 'expired', plan: { id: PLAN }, user: { email: 'mf-succeeded-expired@example.com' } } } },
      'payment.succeeded with expired membership');

    await grantKeepsManualFreeRow(port);
    await grantControlFreeNotManual(port);
    await clearManualFreeAfterGrant(port);

    // A normal active user still goes past_due and gets the payment email.
    insertUser('paid-active@example.com', { status: 'active', manualFree: false });
    const fromPaid = captured.length;
    const paid = await postWebhook(port, { type: 'payment.failed', data: { id: 'pay_paid', user: { email: 'paid-active@example.com' }, plan: { id: PLAN } } });
    assert.strictEqual(paid.status, 200);
    assert.strictEqual(userRow('paid-active@example.com').status, 'past_due', 'normal active user goes past_due');
    assert.strictEqual(userRow('paid-active@example.com').access_granted, 1);
    const paidLines = captured.slice(fromPaid);
    assert.strictEqual(mailTo(paidLines, 'paid-active@example.com').length, 1, 'normal active user gets one payment email');
    assert.ok(paidLines.some((l) => l.includes('payment-failed notice sent to paid-active@example.com')), paidLines.join('\n'));

    // A normal user deactivation still cuts access.
    insertUser('paid-deactivated@example.com', { status: 'active', manualFree: false });
    const deact = await postWebhook(port, { type: 'membership.deactivated', data: { id: 'mem_paid', status: 'active', plan: { id: PLAN }, user: { email: 'paid-deactivated@example.com' } } });
    assert.strictEqual(deact.status, 200);
    assert.strictEqual(userRow('paid-deactivated@example.com').status, 'canceled', 'normal user deactivation still cancels');
    assert.strictEqual(userRow('paid-deactivated@example.com').access_granted, 0, 'normal user deactivation still cuts access');

    // A manual_free user activation keeps access but gets no trial or checkout email.
    insertUser('mf-activated-active@example.com', { status: 'free', manualFree: true });
    const fromAct = captured.length;
    const act = await postWebhook(port, { type: 'membership.activated', data: { id: 'mem_mf_ok', status: 'active', plan: { id: PLAN }, user: { email: 'mf-activated-active@example.com' } } });
    assert.strictEqual(act.status, 200);
    assert.strictEqual(userRow('mf-activated-active@example.com').access_granted, 1);
    assert.strictEqual(userRow('mf-activated-active@example.com').manual_free, 1);
    assert.deepStrictEqual(mailTo(captured.slice(fromAct), 'mf-activated-active@example.com'), [], 'manual_free activation sends no trial email');

    // A new 7 day Whop trial buyer still gets the trial login email.
    const fromBuyer = captured.length;
    const buyer = await postWebhook(port, { type: 'membership.activated', data: { id: 'mem_buyer', status: 'trialing', plan: { id: PLAN }, user: { email: 'trial-buyer@example.com' } } });
    assert.strictEqual(buyer.status, 200);
    assert.strictEqual(userRow('trial-buyer@example.com').status, 'trialing');
    assert.strictEqual(userRow('trial-buyer@example.com').access_granted, 1);
    assert.strictEqual(mailTo(captured.slice(fromBuyer), 'trial-buyer@example.com').length, 1, '7 day Whop trial buyer gets the login email');

    // A normal 7 day Whop trial still gets the trial ending reminder.
    insertUser('trial-ending@example.com', { status: 'trialing', manualFree: false });
    const fromTe = captured.length;
    await postWebhook(port, { type: 'membership.trial_ending_soon', data: { id: 'mem_te', status: 'trialing', plan: { id: PLAN }, user: { email: 'trial-ending@example.com' } } });
    assert.strictEqual(mailTo(captured.slice(fromTe), 'trial-ending@example.com').length, 1, 'normal trial gets the trial ending reminder');

    // A normal 14 day tester invite still sets trialing and sends the tester email.
    const fromTester = captured.length;
    const tester = await createTester(port, 'tester14@example.com');
    assert.strictEqual(tester.status, 200);
    assert.strictEqual(userRow('tester14@example.com').status, 'trialing');
    const days = (Date.parse(userRow('tester14@example.com').trial_end) - Date.now()) / 86400000;
    assert.ok(days > 13.9 && days <= 14, 'tester trial is 14 days');
    assert.strictEqual(mailTo(captured.slice(fromTester), 'tester14@example.com').length, 1, '14 day tester gets the tester email');

    // A normal Stripe subscriber status still follows Stripe.
    insertUser('stripe-paid@example.com', { status: 'active', manualFree: false, stripeCustomer: 'cus_paid' });
    const sp = await postStripe(port, { id: 'evt_paid', type: 'customer.subscription.updated', data: { object: { id: 'sub_paid', customer: 'cus_paid', status: 'past_due' } } });
    assert.strictEqual(sp.status, 200);
    assert.strictEqual(userRow('stripe-paid@example.com').status, 'past_due', 'normal Stripe user status still updates');

    console.log = origLog;
    console.log('lib/manual-free-whop.test.js passed');
  } finally {
    console.log = origLog;
    await new Promise((resolve) => server.close(resolve));
    try { db.close(); } catch (e) {}
    cleanDb();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
