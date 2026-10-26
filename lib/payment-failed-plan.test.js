'use strict';
/**
 * payment.failed must use the same plan check as the grant path.
 * Another Whop product must not mark a Twic user past_due or send email.
 * Past due access (pastDueAccess): a Whop retry with no Stripe ids keeps access on
 * /api/me, password login and the magic link; every other past_due row fails closed,
 * except that a Stripe only row keeps its old login and magic link result.
 * payment.failed marks past_due only for a renewal (subscription_cycle) of the row's own
 * stored membership, in order; the grant ends 7 days after whop_event_at; payment.succeeded
 * on the own membership clears past_due.
 */
const assert = require('assert');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
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
process.env.STRIPE_SECRET_KEY = 'sk_test_unit_only_not_a_real_key';
process.env.STRIPE_WEBHOOK_SECRET = 'whsec_unit_test_stripe_secret';

const { app, db } = require('../server');
const stripeLib = require('stripe')(process.env.STRIPE_SECRET_KEY);
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

const PW = 'past.due.unit.pass.99';
const HASH = bcrypt.hashSync(PW, 4);
const PAST = new Date(Date.UTC(2020, 0, 1)).toISOString();

function seedRow(email, c = {}) {
  db.prepare(`INSERT INTO users (email, status, trial_end, access_granted, manual_free, password_hash,
    whop_status, whop_membership_id, whop_member_id, stripe_customer_id, stripe_subscription_id, whop_event_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(email, c.status || 'past_due', PAST,
    c.access == null ? 1 : c.access, c.manualFree ? 1 : 0, HASH, c.whopStatus || null,
    c.mem || null, c.member || null, c.cus || null, c.sub || null,
    c.eventAt === undefined ? new Date(Date.now() - 60 * 60 * 1000).toISOString() : c.eventAt);
}

function login(port, email) {
  return request(port, { method: 'POST', path: '/api/login', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password: PW }) });
}

function magic(port, email) {
  const token = 'unit.magic.' + email + '.' + Math.random().toString(36).slice(2);
  db.prepare('INSERT OR REPLACE INTO magic_tokens (token, email, expires_at) VALUES (?, ?, ?)').run(token, email, new Date(Date.now() + 600000).toISOString());
  return request(port, { method: 'GET', path: '/api/verify-magic?token=' + encodeURIComponent(token) });
}

function postStripe(port, event) {
  const payload = JSON.stringify(event);
  const header = stripeLib.webhooks.generateTestHeaderString({ payload, secret: process.env.STRIPE_WEBHOOK_SECRET });
  return request(port, { method: 'POST', path: '/api/stripe-webhook', headers: { 'Content-Type': 'application/json', 'stripe-signature': header }, body: payload });
}

// /api/me, password login and magic link status codes, in that order.
async function access(port, email) {
  return [(await meStatus(port, email)).status, (await login(port, email)).status, (await magic(port, email)).status];
}

async function expectAccess(port, email, expected, label) {
  assert.deepStrictEqual(await access(port, email), expected, `${label}: [me, login, magic]`);
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
    // The row has no stored Whop membership and the event names none, so status is unchanged.
    // The notice still goes out. The renewal of a stored membership below does set past_due.
    assert.strictEqual(twicRow.status, 'active', 'a Twic-plan failure for no stored membership leaves status');
    assert.strictEqual(twicRow.access_granted, 1, 'a Twic-plan failure leaves access_granted unchanged');
    const twicLog = captured.slice(beforeTwic).join('\n');
    assert.ok(/payment\.failed left twic-plan@example\.com unchanged/.test(twicLog), twicLog);
    assert.strictEqual(/marked twic-plan@example.com past_due/.test(twicLog), false, twicLog);
    assert.ok(/payment-failed notice sent to twic-plan@example.com/.test(twicLog), twicLog);
    assert.ok(/\[WHOP EMAIL to twic-plan@example.com\]/.test(twicLog), twicLog);
    assert.strictEqual(twicRow.whop_status, null, 'payment.failed writes no shadow on a row with no stored membership');

    insertUser('no-plan@example.com', { status: 'active', access_granted: 1 });
    const noPlan = await postWebhook(port, failedPayment('no-plan@example.com'));
    assert.strictEqual(noPlan.status, 200);
    const noPlanRow = userRow('no-plan@example.com');
    assert.strictEqual(noPlanRow.status, 'active', 'a missing plan id with no stored membership leaves status');
    assert.strictEqual(noPlanRow.access_granted, 1);

    // Past due access. A real Whop retry: a timed payment.failed on the row's own membership.
    const OK = [200, 200, 200];
    const NO = [403, 403, 403];
    const STRIPE_LOGIN = [403, 200, 200];
    const T0 = Date.now() - 60 * 60 * 1000;
    const at = (n) => new Date(T0 + n * 1000).toISOString();
    db.prepare(`INSERT INTO users (email, status, access_granted, password_hash, whop_membership_id) VALUES (?, 'active', 1, ?, 'mem_pd_retry')`).run('pd.retry@example.com', HASH);
    const retry = await postWebhook(port, { type: 'payment.failed', data: { id: 'pay_pd_retry', billing_reason: 'subscription_cycle', updated_at: at(10), membership: { id: 'mem_pd_retry' }, user: { email: 'pd.retry@example.com' }, plan: { id: PLAN } } });
    assert.strictEqual(retry.status, 200);
    assert.strictEqual(userRow('pd.retry@example.com').status, 'past_due');
    assert.strictEqual(userRow('pd.retry@example.com').whop_status, 'past_due');
    await expectAccess(port, 'pd.retry@example.com', OK, 'Whop retry with no Stripe ids keeps access everywhere');
    // Whop then cancels: cut off everywhere.
    await postWebhook(port, { type: 'membership.deactivated', data: { id: 'mem_pd_retry', status: 'canceled', updated_at: at(20), plan: { id: PLAN }, user: { email: 'pd.retry@example.com' } } });
    assert.strictEqual(userRow('pd.retry@example.com').whop_status, 'canceled');
    await expectAccess(port, 'pd.retry@example.com', NO, 'Whop cancel after the retry cuts access');

    // S1: an expired tester (no Whop membership stored) stays 403 after a failed payment,
    // whatever the event says, including a renewal with a membership id and no plan id.
    const failedFor = (email, n, extra) => ({ type: 'payment.failed', data: { id: 'pay_' + n, updated_at: at(n), user: { email }, ...extra } });
    for (const [label, extra] of [
      ['renewal with a membership id', { billing_reason: 'subscription_cycle', membership: { id: 'mem_tester_new' }, plan: { id: PLAN } }],
      ['first purchase', { billing_reason: 'subscription_create', membership: { id: 'mem_tester_new2' }, plan: { id: PLAN } }],
      ['no plan id and no billing reason', { membership: { id: 'mem_tester_new3' } }],
    ]) {
      const email = `expired.tester.${label.replace(/\W+/g, '.')}@example.com`;
      db.prepare(`INSERT INTO users (email, status, trial_end, access_granted, password_hash) VALUES (?, 'trialing', ?, 1, ?)`).run(email, PAST, HASH);
      await expectAccess(port, email, NO, `expired tester before: ${label}`);
      assert.strictEqual((await postWebhook(port, failedFor(email, 40, extra))).status, 200);
      assert.strictEqual(userRow(email).status, 'trialing', `expired tester status unchanged: ${label}`);
      await expectAccess(port, email, NO, `expired tester stays 403 after payment.failed: ${label}`);
    }

    // S1: only a renewal (subscription_cycle) of the row's own membership marks it past_due.
    db.prepare(`INSERT INTO users (email, status, access_granted, password_hash, whop_membership_id) VALUES (?, 'active', 1, ?, 'mem_pd_create')`).run('pd.create@example.com', HASH);
    await postWebhook(port, failedFor('pd.create@example.com', 41, { billing_reason: 'subscription_create', membership: { id: 'mem_pd_create' }, plan: { id: PLAN } }));
    assert.strictEqual(userRow('pd.create@example.com').status, 'active', 'a non renewal failure leaves status');
    await expectAccess(port, 'pd.create@example.com', OK, 'a non renewal failure leaves access');

    // S3: a late payment.failed after a later success is stale and changes nothing.
    db.prepare(`INSERT INTO users (email, status, access_granted, password_hash, whop_membership_id) VALUES (?, 'active', 1, ?, 'mem_pd_late')`).run('pd.late@example.com', HASH);
    await postWebhook(port, { type: 'payment.succeeded', data: { id: 'pay_pd_late2', updated_at: at(60), user: { email: 'pd.late@example.com' }, membership: { id: 'mem_pd_late', status: 'active' }, plan: { id: PLAN } } });
    await postWebhook(port, failedFor('pd.late@example.com', 50, { billing_reason: 'subscription_cycle', membership: { id: 'mem_pd_late' }, plan: { id: PLAN } }));
    assert.strictEqual(userRow('pd.late@example.com').status, 'active', 'a stale payment.failed leaves status');
    assert.strictEqual(userRow('pd.late@example.com').whop_status, 'active');
    await expectAccess(port, 'pd.late@example.com', OK, 'a stale payment.failed does not lock out a paid member');

    // S3: a payment.failed naming another membership changes nothing.
    db.prepare(`INSERT INTO users (email, status, access_granted, password_hash, whop_membership_id) VALUES (?, 'active', 1, ?, 'mem_pd_mine')`).run('pd.othermem@example.com', HASH);
    await postWebhook(port, failedFor('pd.othermem@example.com', 70, { billing_reason: 'subscription_cycle', membership: { id: 'mem_pd_theirs' }, plan: { id: PLAN } }));
    assert.strictEqual(userRow('pd.othermem@example.com').status, 'active', 'another membership leaves status');
    await expectAccess(port, 'pd.othermem@example.com', OK, 'another membership does not lock out the member');

    // S2: a Whop retry keeps access for 7 days after whop_event_at, then fails closed (stubbed Date.now).
    db.prepare(`INSERT INTO users (email, status, access_granted, password_hash, whop_membership_id) VALUES (?, 'active', 1, ?, 'mem_pd_cap')`).run('pd.cap@example.com', HASH);
    await postWebhook(port, failedFor('pd.cap@example.com', 80, { billing_reason: 'subscription_cycle', membership: { id: 'mem_pd_cap' }, plan: { id: PLAN } }));
    const capRow = userRow('pd.cap@example.com');
    assert.strictEqual(capRow.status, 'past_due');
    assert.strictEqual(capRow.whop_event_at, at(80));
    const capMs = Date.parse(capRow.whop_event_at) + 7 * 24 * 60 * 60 * 1000;
    const realNow = Date.now;
    try {
      Date.now = () => capMs - 1000;
      await expectAccess(port, 'pd.cap@example.com', OK, 'one second before the 7 day cap');
      Date.now = () => capMs;
      await expectAccess(port, 'pd.cap@example.com', OK, 'exactly at the 7 day cap');
      Date.now = () => capMs + 1000;
      await expectAccess(port, 'pd.cap@example.com', NO, 'one second after the 7 day cap');
    } finally {
      Date.now = realNow;
    }
    seedRow('pd.since2021@example.com', { whopStatus: 'past_due', mem: 'mem_pd_2021', eventAt: '2021-01-01T00:00:00.000Z' });
    await expectAccess(port, 'pd.since2021@example.com', NO, 'Whop past_due since 2021');

    // Q1: activated, then failed, then succeeded on the same membership ends with normal access.
    db.prepare(`INSERT INTO users (email, status, access_granted, password_hash) VALUES (?, 'canceled', 0, ?)`).run('pd.recover@example.com', HASH);
    await postWebhook(port, { type: 'membership.activated', data: { id: 'mem_pd_rec', status: 'active', updated_at: at(90), plan: { id: PLAN }, user: { email: 'pd.recover@example.com' } } });
    assert.strictEqual(userRow('pd.recover@example.com').status, 'active');
    assert.strictEqual(userRow('pd.recover@example.com').whop_membership_id, 'mem_pd_rec');
    await postWebhook(port, failedFor('pd.recover@example.com', 100, { billing_reason: 'subscription_cycle', membership: { id: 'mem_pd_rec' }, plan: { id: PLAN } }));
    assert.strictEqual(userRow('pd.recover@example.com').status, 'past_due');
    await expectAccess(port, 'pd.recover@example.com', OK, 'recover: Whop retry keeps access');
    // A success for another membership, or an older one, does not clear it.
    await postWebhook(port, { type: 'payment.succeeded', data: { id: 'pay_pd_rec_other', updated_at: at(105), user: { email: 'pd.recover@example.com' }, membership: { id: 'mem_pd_other', status: 'active' }, plan: { id: PLAN } } });
    assert.strictEqual(userRow('pd.recover@example.com').status, 'past_due', 'another membership paid: still past_due');
    await postWebhook(port, { type: 'payment.succeeded', data: { id: 'pay_pd_rec_old', updated_at: at(95), user: { email: 'pd.recover@example.com' }, membership: { id: 'mem_pd_rec', status: 'active' }, plan: { id: PLAN } } });
    assert.strictEqual(userRow('pd.recover@example.com').status, 'past_due', 'an older success: still past_due');
    // The Whop v1 payment shape: user at the root, membership with id and status only.
    const beforeRec = captured.length;
    await postWebhook(port, { type: 'payment.succeeded', data: { id: 'pay_pd_rec_ok', updated_at: at(110), user: { email: 'pd.recover@example.com' }, membership: { id: 'mem_pd_rec', status: 'active' }, plan: { id: PLAN } } });
    const recRow = userRow('pd.recover@example.com');
    assert.strictEqual(recRow.status, 'active', 'payment.succeeded on the own membership clears past_due');
    assert.strictEqual(recRow.access_granted, 1);
    assert.strictEqual(recRow.whop_status, 'active');
    assert.strictEqual(/trial is ready/.test(captured.slice(beforeRec).join('\n')), false, 'no trial ready email on recovery');
    await expectAccess(port, 'pd.recover@example.com', OK, 'recover: access after payment.succeeded');
    // Still allowed after the 7 day cap, because the row is active again.
    try {
      Date.now = () => Date.parse(recRow.whop_event_at) + 8 * 24 * 60 * 60 * 1000;
      await expectAccess(port, 'pd.recover@example.com', OK, 'recover: access past the past_due cap');
    } finally {
      Date.now = realNow;
    }

    // Q1: an admin revoke stands. A revoked past_due row stays revoked after payment.succeeded.
    seedRow('pd.revoked.paid@example.com', { access: 0, whopStatus: 'past_due', mem: 'mem_pd_rvp', eventAt: at(120) });
    await postWebhook(port, { type: 'payment.succeeded', data: { id: 'pay_pd_rvp', updated_at: at(130), user: { email: 'pd.revoked.paid@example.com' }, membership: { id: 'mem_pd_rvp', status: 'active' }, plan: { id: PLAN } } });
    assert.strictEqual(userRow('pd.revoked.paid@example.com').status, 'active');
    assert.strictEqual(userRow('pd.revoked.paid@example.com').access_granted, 0, 'revoke stands');
    await expectAccess(port, 'pd.revoked.paid@example.com', NO, 'revoked row stays 403 after payment.succeeded');

    // Stale Whop shadow past_due, then Stripe sets past_due on the same row: 403 everywhere.
    db.prepare(`INSERT INTO users (email, status, access_granted, password_hash, whop_membership_id, stripe_customer_id, stripe_subscription_id) VALUES (?, 'active', 1, ?, 'mem_pd_stale', 'cus_pd_stale', 'sub_pd_stale')`).run('pd.stale.stripe@example.com', HASH);
    await postWebhook(port, { type: 'payment.failed', data: { id: 'pay_pd_stale', updated_at: at(30), membership: { id: 'mem_pd_stale' }, user: { email: 'pd.stale.stripe@example.com' }, plan: { id: PLAN } } });
    const sp = await postStripe(port, { id: 'evt_pd_stale', type: 'customer.subscription.updated', data: { object: { id: 'sub_pd_stale', customer: 'cus_pd_stale', status: 'past_due' } } });
    assert.strictEqual(sp.status, 200, `stripe webhook 200 (got ${sp.status} ${sp.raw})`);
    assert.strictEqual(userRow('pd.stale.stripe@example.com').status, 'past_due');
    assert.strictEqual(userRow('pd.stale.stripe@example.com').whop_status, 'past_due');
    await expectAccess(port, 'pd.stale.stripe@example.com', NO, 'stale Whop shadow plus Stripe past_due');
    seedRow('pd.stale.cus@example.com', { whopStatus: 'past_due', cus: 'cus_pd_sc' });
    await expectAccess(port, 'pd.stale.cus@example.com', NO, 'Whop shadow past_due plus a Stripe customer id only');
    seedRow('pd.stale.sub@example.com', { whopStatus: 'past_due', sub: 'sub_pd_ss' });
    await expectAccess(port, 'pd.stale.sub@example.com', NO, 'Whop shadow past_due plus a Stripe subscription id only');
    seedRow('pd.stale.blank@example.com', { whopStatus: 'past_due', cus: ' ' });
    await expectAccess(port, 'pd.stale.blank@example.com', NO, 'a blank Stripe id still counts as a Stripe id');

    // An old Whop id plus Stripe past_due: 403 everywhere.
    seedRow('pd.oldmem.stripe@example.com', { mem: 'mem_pd_old', cus: 'cus_pd_old', sub: 'sub_pd_old' });
    await expectAccess(port, 'pd.oldmem.stripe@example.com', NO, 'old Whop membership id plus Stripe past_due');
    seedRow('pd.oldmember.stripe@example.com', { member: 'user_pd_old', cus: 'cus_pd_old2' });
    await expectAccess(port, 'pd.oldmember.stripe@example.com', NO, 'old Whop member id plus Stripe past_due');
    seedRow('pd.oldcancel.stripe@example.com', { mem: 'mem_pd_oc', whopStatus: 'canceled', cus: 'cus_pd_oc' });
    await expectAccess(port, 'pd.oldcancel.stripe@example.com', NO, 'Whop canceled shadow plus Stripe past_due');

    // Rows from before the shadow existed (whop_status NULL) with past_due: 403 everywhere.
    seedRow('pd.pre37.mem@example.com', { mem: 'mem_pd_pre' });
    await expectAccess(port, 'pd.pre37.mem@example.com', NO, 'pre shadow Whop membership row');
    seedRow('pd.pre37.member@example.com', { member: 'user_pd_pre' });
    await expectAccess(port, 'pd.pre37.member@example.com', NO, 'pre shadow Whop member row');
    seedRow('pd.pre37.none@example.com', {});
    await expectAccess(port, 'pd.pre37.none@example.com', NO, 'pre shadow row with no billing ids');

    // Stripe only past_due: login and magic link unchanged, /api/me unchanged (403).
    seedRow('pd.stripe.only@example.com', { cus: 'cus_pd_only', sub: 'sub_pd_only' });
    await expectAccess(port, 'pd.stripe.only@example.com', STRIPE_LOGIN, 'Stripe only past_due');
    seedRow('pd.stripe.cusonly@example.com', { cus: 'cus_pd_co' });
    await expectAccess(port, 'pd.stripe.cusonly@example.com', STRIPE_LOGIN, 'Stripe customer id only past_due');

    // Revoked and other shadow states fail closed.
    seedRow('pd.revoked@example.com', { access: 0, whopStatus: 'past_due', mem: 'mem_pd_rv' });
    await expectAccess(port, 'pd.revoked@example.com', NO, 'revoked Whop retry');
    for (const ws of ['unknown', 'active', 'trialing', 'canceled']) {
      seedRow(`pd.shadow.${ws}@example.com`, { whopStatus: ws, mem: 'mem_pd_' + ws });
      await expectAccess(port, `pd.shadow.${ws}@example.com`, NO, `past_due with whop_status ${ws}`);
    }

    // manual_free is unaffected by any of it.
    seedRow('pd.mf.stripe@example.com', { manualFree: 1, whopStatus: 'past_due', cus: 'cus_pd_mf', sub: 'sub_pd_mf', mem: 'mem_pd_mf' });
    await expectAccess(port, 'pd.mf.stripe@example.com', OK, 'manual_free past_due with Stripe and Whop ids');
    seedRow('pd.mf.pre37@example.com', { manualFree: 1, mem: 'mem_pd_mf2' });
    await expectAccess(port, 'pd.mf.pre37@example.com', OK, 'manual_free past_due with no shadow');
    seedRow('pd.mf.free@example.com', { manualFree: 1, status: 'free', whopStatus: 'past_due', cus: 'cus_pd_mf3' });
    await expectAccess(port, 'pd.mf.free@example.com', OK, 'manual_free free with a past_due shadow');

    // Table: status x whop_status x Stripe ids x Whop ids, through all three paths.
    let n = 0;
    for (const status of ['past_due', 'active', 'canceled']) {
      for (const whopStatus of [null, 'past_due', 'active', 'canceled', 'unknown']) {
        for (const [cus, sub] of [[null, null], ['cus_t', null], [null, 'sub_t'], ['cus_t', 'sub_t']]) {
          for (const mem of [null, 'mem_t']) {
            const email = `pd.table.${++n}@example.com`;
            seedRow(email, { status, whopStatus, cus: cus && cus + n, sub: sub && sub + n, mem: mem && mem + n });
            const noStripe = !cus && !sub;
            let expected = NO;
            if (status === 'active') expected = OK;
            else if (status === 'past_due' && whopStatus === 'past_due' && noStripe && mem) expected = OK;
            else if (status === 'past_due' && !noStripe && whopStatus === null && !mem) expected = STRIPE_LOGIN;
            await expectAccess(port, email, expected, `table ${status} ${whopStatus} ${cus} ${sub} ${mem}`);
          }
        }
      }
    }
    assert.strictEqual(n, 120, 'every table row ran');

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
