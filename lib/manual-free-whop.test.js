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
  // (c) Clearing manual_free after a Whop trial grant whose trial has no future trial_end on the row:
  // not a live membership, so the account must pay (status canceled), with no bounce and no mail.
  const email = 'mf-cleared@example.com';
  insertRaw(email, { status: 'free', access: 1, manualFree: 1, trialEnd: null });
  const from = captured.length;
  await postWebhook(port, { type: 'membership.activated', data: { id: 'mem_gc', status: 'trialing', plan: { id: PLAN }, user: { email }, renewal_period_end: '2020-01-01T00:00:00Z' } });
  const cleared = await setAccess(port, email, { access_granted: true, manual_free: false });
  assert.strictEqual(cleared.status, 200);
  assert.strictEqual(userRow(email).manual_free, 0);
  assert.strictEqual(userRow(email).status, 'canceled', 'cleared manual_free without a live membership is canceled');
  const me = await meStatus(port, email);
  assert.strictEqual(me.status, 403, `cleared manual_free without a live membership has no access (got ${me.status})`);
  const lines = captured.slice(from);
  assert.deepStrictEqual(mailTo(lines, email), [], 'no mail on grant or clear');
  assert.strictEqual(lines.some((l) => l.includes(`trial-ending reminder sent to ${email}`)), false, 'no trial ending email');
}

const bcrypt = require('bcryptjs');
const LOGIN_PASSWORD = 'unit-test-login-password';
const LOGIN_HASH = bcrypt.hashSync(LOGIN_PASSWORD, 4);

function fullRow(email) {
  return db.prepare('SELECT * FROM users WHERE email = ?').get(email);
}

function seedManualFree(email, { status, trialEnd = null, access = 1 }) {
  db.prepare('INSERT INTO users (email, status, access_granted, manual_free, trial_end, password_hash) VALUES (?, ?, ?, 1, ?, ?)')
    .run(email, status, access, trialEnd, LOGIN_HASH);
}

function loginStatus(port, email) {
  return request(port, {
    method: 'POST',
    path: '/api/login',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: LOGIN_PASSWORD }),
  });
}

const FUTURE = '2030-01-01T00:00:00.000Z';
const PAST = '2020-01-01T00:00:00.000Z';
const mem = (type, id, status, email, extra = {}) => ({ type, data: { id, status, plan: { id: PLAN }, user: { email }, ...extra } });

// Clears manual_free the way the admin Remove free button does and checks the result is consistent.
async function removeFree(port, email, label, { expectStatus, expectAccess }) {
  const from = captured.length;
  const res = await setAccess(port, email, { access_granted: true, manual_free: false });
  assert.strictEqual(res.status, 200, `${label}: set-access 200`);
  const row = fullRow(email);
  assert.strictEqual(row.manual_free, 0, `${label}: manual_free cleared`);
  assert.strictEqual(row.status, expectStatus, `${label}: status after Remove free`);
  const me = await meStatus(port, email);
  const login = await loginStatus(port, email);
  if (expectAccess) {
    assert.strictEqual(me.status, 200, `${label}: /api/me 200 (got ${me.status} ${me.raw})`);
    assert.strictEqual(JSON.parse(me.raw).status, expectStatus, `${label}: /api/me status`);
    assert.strictEqual(login.status, 200, `${label}: /api/login 200 (got ${login.status} ${login.raw})`);
  } else {
    assert.strictEqual(me.status, 403, `${label}: /api/me 403 (got ${me.status} ${me.raw})`);
    assert.strictEqual(login.status, 403, `${label}: /api/login 403 (got ${login.status} ${login.raw})`);
  }
  // No bounce: /api/me and /api/login always agree.
  assert.strictEqual(me.status === 200, login.status === 200, `${label}: /api/me and /api/login agree`);
  const lines = captured.slice(from);
  assert.deepStrictEqual(lines.filter((l) => l.includes('[WHOP EMAIL to') || l.includes('[MAGIC LINK for')), [], `${label}: no mail on Remove free`);
  return row;
}

async function removeFreeRecomputes(port) {
  // The three REAL PROBLEMs found on 91cfaa56.
  seedManualFree('rp-free-forever@example.com', { status: 'free' });
  await removeFree(port, 'rp-free-forever@example.com', 'status free with no Whop membership must pay', { expectStatus: 'canceled', expectAccess: false });

  seedManualFree('rp-canceled-payer@example.com', { status: 'canceled' });
  await postWebhook(port, mem('membership.activated', 'mem_rp2', 'active', 'rp-canceled-payer@example.com'));
  assert.strictEqual(fullRow('rp-canceled-payer@example.com').status, 'canceled', 'manual_free status unchanged by grant');
  await removeFree(port, 'rp-canceled-payer@example.com', 'canceled status but live paying member keeps access', { expectStatus: 'active', expectAccess: true });

  seedManualFree('rp-stale-trial@example.com', { status: 'trialing', trialEnd: PAST });
  await removeFree(port, 'rp-stale-trial@example.com', 'stale trialing with no membership does not bounce', { expectStatus: 'canceled', expectAccess: false });

  // F7 seeds: canceled, trialing and live membership manual_free rows.
  // Paying: live trialing membership with a future trial_end keeps the trial.
  seedManualFree('f7-trialing-live@example.com', { status: 'trialing', trialEnd: FUTURE });
  await postWebhook(port, mem('membership.went_valid', 'mem_f7t', 'trialing', 'f7-trialing-live@example.com', { renewal_period_end: FUTURE }));
  const kept = await removeFree(port, 'f7-trialing-live@example.com', 'live trialing membership keeps access', { expectStatus: 'trialing', expectAccess: true });
  assert.strictEqual(kept.trial_end, FUTURE, 'trial_end kept for live trial');
  // Paying: live active membership from payment.succeeded (membership shape and email only shape).
  seedManualFree('f7-live-succeeded@example.com', { status: 'free' });
  await postWebhook(port, { type: 'payment.succeeded', data: { id: 'pay_f7', membership: { id: 'mem_f7s', status: 'active', plan: { id: PLAN }, user: { email: 'f7-live-succeeded@example.com' } } } });
  await removeFree(port, 'f7-live-succeeded@example.com', 'live member from payment.succeeded keeps access', { expectStatus: 'active', expectAccess: true });
  seedManualFree('f7-live-emailonly@example.com', { status: 'canceled' });
  await postWebhook(port, { type: 'payment.succeeded', data: { email: 'f7-live-emailonly@example.com' } });
  assert.strictEqual(fullRow('f7-live-emailonly@example.com').status, 'canceled', 'email only payment.succeeded leaves manual_free status');
  await removeFree(port, 'f7-live-emailonly@example.com', 'email only payment.succeeded member keeps access', { expectStatus: 'active', expectAccess: true });

  // Non paying: membership ended, payment failed, trial ended, or never a member.
  for (const type of ['membership.deactivated', 'membership.went_invalid', 'membership.canceled']) {
    const email = `f7-ended-${type.split('.')[1]}@example.com`;
    seedManualFree(email, { status: 'free' });
    await postWebhook(port, mem('membership.activated', 'mem_' + type, 'active', email));
    await postWebhook(port, mem(type, 'mem_' + type, 'active', email));
    assert.strictEqual(fullRow(email).whop_status, 'canceled', `${type}: whop_status canceled on manual_free row`);
    assert.strictEqual(fullRow(email).status, 'free', `${type}: manual_free status unchanged`);
    await removeFree(port, email, `${type} member must pay`, { expectStatus: 'canceled', expectAccess: false });
  }
  seedManualFree('f7-past-due@example.com', { status: 'free' });
  await postWebhook(port, mem('membership.activated', 'mem_f7pd', 'active', 'f7-past-due@example.com'));
  await postWebhook(port, { type: 'payment.failed', data: { id: 'pay_f7pd', user: { email: 'f7-past-due@example.com' }, plan: { id: PLAN } } });
  assert.strictEqual(fullRow('f7-past-due@example.com').whop_status, 'past_due');
  assert.strictEqual(fullRow('f7-past-due@example.com').status, 'free', 'payment.failed leaves manual_free status');
  await removeFree(port, 'f7-past-due@example.com', 'past_due member must pay', { expectStatus: 'canceled', expectAccess: false });
  seedManualFree('f7-trial-over@example.com', { status: 'trialing', trialEnd: PAST });
  await postWebhook(port, mem('membership.went_valid', 'mem_f7to', 'trialing', 'f7-trial-over@example.com'));
  await removeFree(port, 'f7-trial-over@example.com', 'whop trialing with past trial_end must pay', { expectStatus: 'canceled', expectAccess: false });
  seedManualFree('f7-canceled-null@example.com', { status: 'canceled' });
  assert.strictEqual(fullRow('f7-canceled-null@example.com').whop_status, null);
  await removeFree(port, 'f7-canceled-null@example.com', 'canceled with whop_status null must pay', { expectStatus: 'canceled', expectAccess: false });
  seedManualFree('f7-active-null@example.com', { status: 'active' });
  await removeFree(port, 'f7-active-null@example.com', 'status active but whop_status null must pay', { expectStatus: 'canceled', expectAccess: false });

  // Admin access toggle is respected on Remove free (Revoke stays revoked).
  seedManualFree('f7-revoked-payer@example.com', { status: 'free', access: 0 });
  db.prepare(`UPDATE users SET whop_status = 'active' WHERE email = ?`).run('f7-revoked-payer@example.com');
  await setAccess(port, 'f7-revoked-payer@example.com', { access_granted: false, manual_free: false });
  assert.strictEqual(fullRow('f7-revoked-payer@example.com').access_granted, 0, 'Remove free keeps admin access_granted 0');
  assert.strictEqual(fullRow('f7-revoked-payer@example.com').status, 'active');

  // Controls: Grant, Revoke and Make free forever do not recompute status.
  insertRaw('ctl-not-free@example.com', { status: 'trialing', access: 1, manualFree: 0, trialEnd: FUTURE });
  await setAccess(port, 'ctl-not-free@example.com', { access_granted: false, manual_free: false });
  await setAccess(port, 'ctl-not-free@example.com', { access_granted: true, manual_free: false });
  assert.strictEqual(fullRow('ctl-not-free@example.com').status, 'trialing', 'Grant and Revoke leave status alone');
  await setAccess(port, 'ctl-not-free@example.com', { access_granted: true, manual_free: true });
  assert.strictEqual(fullRow('ctl-not-free@example.com').status, 'trialing', 'Make free forever leaves status alone');
  seedManualFree('ctl-stays-free@example.com', { status: 'free' });
  await setAccess(port, 'ctl-stays-free@example.com', { access_granted: false, manual_free: true });
  assert.strictEqual(fullRow('ctl-stays-free@example.com').status, 'free', 'Revoke on a manual_free row leaves status alone');
}

async function whopStatusWrittenOnEveryEvent(port) {
  const cases = [
    ['membership.activated active', (e) => mem('membership.activated', 'mem_ws1', 'active', e), 'active'],
    ['membership.went_valid trialing', (e) => mem('membership.went_valid', 'mem_ws2', 'trialing', e), 'trialing'],
    ['membership.created no status', (e) => ({ type: 'membership.created', data: { id: 'mem_ws3', plan: { id: PLAN }, user: { email: e } } }), 'active'],
    ['membership.activated past_due', (e) => mem('membership.activated', 'mem_ws4', 'past_due', e), 'past_due'],
    ['membership.activated unresolved', (e) => mem('membership.activated', 'mem_ws5', 'unresolved', e), 'past_due'],
    ['membership.activated expired', (e) => mem('membership.activated', 'mem_ws6', 'expired', e), 'canceled'],
    ['membership.deactivated', (e) => mem('membership.deactivated', 'mem_ws7', 'active', e), 'canceled'],
    ['membership.went_invalid', (e) => mem('membership.went_invalid', 'mem_ws8', 'active', e), 'canceled'],
    ['membership.canceled', (e) => mem('membership.canceled', 'mem_ws9', 'active', e), 'canceled'],
    ['membership.trial_ending_soon', (e) => mem('membership.trial_ending_soon', 'mem_ws10', 'trialing', e, { renewal_period_end: FUTURE }), 'trialing'],
    ['payment.failed', (e) => ({ type: 'payment.failed', data: { id: 'pay_ws11', user: { email: e }, plan: { id: PLAN } } }), 'past_due'],
    ['payment.succeeded membership', (e) => ({ type: 'payment.succeeded', data: { id: 'pay_ws12', membership: { id: 'mem_ws12', status: 'active', plan: { id: PLAN }, user: { email: e } } } }), 'active'],
    ['payment.succeeded email only', (e) => ({ type: 'payment.succeeded', data: { email: e } }), 'active'],
  ];
  let i = 0;
  for (const [label, make, expected] of cases) {
    i += 1;
    for (const manual of [1, 0]) {
      const email = `ws-${i}-${manual ? 'mf' : 'paid'}@example.com`;
      insertRaw(email, { status: 'free', access: 1, manualFree: manual, trialEnd: null });
      const before = userRow(email);
      const from = captured.length;
      const res = await postWebhook(port, make(email));
      assert.strictEqual(res.status, 200, `${label}: webhook 200`);
      assert.strictEqual(fullRow(email).whop_status, expected, `${label}: whop_status ${expected} (manual_free ${manual})`);
      if (manual) {
        const after = userRow(email);
        assert.strictEqual(after.status, before.status, `${label}: manual_free status unchanged`);
        assert.strictEqual(after.trial_end, before.trial_end, `${label}: manual_free trial_end unchanged`);
        assert.deepStrictEqual(mailTo(captured.slice(from), email), [], `${label}: no mail to manual_free`);
      }
    }
  }
  // Events for other Whop products are still ignored and write nothing.
  insertRaw('ws-foreign@example.com', { status: 'free', access: 1, manualFree: 1, trialEnd: null });
  await postWebhook(port, { type: 'membership.activated', data: { id: 'mem_foreign', status: 'active', plan: { id: 'plan_NOTTWIC_fake0001' }, user: { email: 'ws-foreign@example.com' } } });
  assert.strictEqual(fullRow('ws-foreign@example.com').whop_status, null, 'foreign plan event writes no whop_status');
}

function migrationIsAdditiveAndIdempotent() {
  const Database = require('better-sqlite3');
  const { ensureWhopStatusColumn } = require('./security');
  const { execFileSync } = require('child_process');
  // Users schema as shipped before whop_status (91cfaa56).
  const preSchema = `
    CREATE TABLE users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      email TEXT UNIQUE NOT NULL,
      stripe_customer_id TEXT,
      stripe_subscription_id TEXT,
      status TEXT DEFAULT 'trialing',
      trial_end TEXT,
      access_granted INTEGER DEFAULT 1,
      manual_free INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now')),
      password_hash TEXT,
      group_name TEXT,
      whop_membership_id TEXT,
      whop_member_id TEXT
    );
    INSERT INTO users (email, status, trial_end, access_granted, manual_free, whop_membership_id, created_at)
      VALUES ('old-free@example.com', 'free', NULL, 1, 1, 'mem_old', '2026-01-01 00:00:00'),
             ('old-trial@example.com', 'trialing', '2030-01-01T00:00:00.000Z', 1, 0, NULL, '2026-01-02 00:00:00');
  `;
  const files = [];
  const mkDb = (tag) => {
    const file = path.join(os.tmpdir(), `wic-whopstatus-mig-${tag}-${process.pid}.db`);
    files.push(file, file + '-wal', file + '-shm');
    for (const f of [file, file + '-wal', file + '-shm']) { try { fs.unlinkSync(f); } catch (e) {} }
    const d = new Database(file);
    d.exec(preSchema);
    return { file, d };
  };
  try {
    // Unit: the migration helper, run twice.
    const { d } = mkDb('unit');
    const before = d.prepare('SELECT * FROM users ORDER BY id').all();
    assert.strictEqual(ensureWhopStatusColumn(d), true, 'first run adds whop_status');
    assert.strictEqual(ensureWhopStatusColumn(d), false, 'second run is a no op');
    const cols = d.prepare('PRAGMA table_info(users)').all().filter((c) => c.name === 'whop_status');
    assert.strictEqual(cols.length, 1, 'exactly one whop_status column');
    assert.strictEqual(cols[0].notnull, 0, 'whop_status is nullable');
    assert.strictEqual(cols[0].dflt_value, null, 'whop_status has no default');
    const after = d.prepare('SELECT * FROM users ORDER BY id').all();
    assert.deepStrictEqual(after.map(({ whop_status, ...rest }) => rest), before, 'existing rows untouched');
    assert.ok(after.every((r) => r.whop_status === null), 'existing rows get NULL whop_status');
    d.close();

    // Startup: real server.js schema block against a pre migration DB, started twice.
    const { file, d: d2 } = mkDb('startup');
    const startBefore = d2.prepare('SELECT * FROM users ORDER BY id').all();
    d2.close();
    for (let run = 1; run <= 2; run++) {
      execFileSync(process.execPath, ['-e', "require('./server'); process.exit(0)"], {
        cwd: path.join(__dirname, '..'),
        env: { ...process.env, WIC_DB_PATH: file },
        stdio: 'ignore',
      });
      const d3 = new Database(file, { readonly: true });
      const startCols = d3.prepare('PRAGMA table_info(users)').all().filter((c) => c.name === 'whop_status');
      assert.strictEqual(startCols.length, 1, `server start ${run}: one whop_status column`);
      const rows = d3.prepare('SELECT * FROM users ORDER BY id').all();
      assert.deepStrictEqual(rows.map(({ whop_status, ...rest }) => rest), startBefore, `server start ${run}: rows untouched`);
      assert.ok(rows.every((r) => r.whop_status === null), `server start ${run}: NULL whop_status`);
      d3.close();
    }
  } finally {
    for (const f of files) { try { fs.unlinkSync(f); } catch (e) {} }
  }
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

    // QA F1: an email only payment.succeeded (no membership id, status or user) leaves manual_free rows alone.
    for (const [label, make] of [
      ['data.email', (e) => ({ email: e })],
      ['data.customer.email', (e) => ({ customer: { email: e } })],
      ['data.metadata.email', (e) => ({ metadata: { email: e } })],
    ]) {
      const email = `mf-succeeded-emailonly-${label.replace(/\./g, '-')}@example.com`;
      await expectUntouched(port, email, { type: 'payment.succeeded', data: make(email) }, `payment.succeeded email only ${label}`);
    }
    for (const [seed, row] of [
      ['canceled', { status: 'canceled', access: 0, trialEnd: null }],
      ['trialing', { status: 'trialing', access: 1, trialEnd: '2030-01-01T00:00:00.000Z' }],
    ]) {
      const email = `mf-succeeded-emailonly-${seed}@example.com`;
      insertRaw(email, { ...row, manualFree: 1 });
      const before = userRow(email);
      const from = captured.length;
      const res = await postWebhook(port, { type: 'payment.succeeded', data: { email } });
      assert.strictEqual(res.status, 200);
      assert.deepStrictEqual(userRow(email), before, `email only payment.succeeded leaves ${seed} manual_free row unchanged`);
      assert.deepStrictEqual(mailTo(captured.slice(from), email), [], `email only payment.succeeded sends no mail to ${seed} manual_free row`);
    }
    // Control: a non manual_free user is still marked active by the email only shape.
    insertRaw('emailonly-control@example.com', { status: 'canceled', access: 0, manualFree: 0, trialEnd: null });
    await postWebhook(port, { type: 'payment.succeeded', data: { email: 'emailonly-control@example.com' } });
    assert.strictEqual(userRow('emailonly-control@example.com').status, 'active', 'email only payment.succeeded still activates a normal user');
    assert.strictEqual(userRow('emailonly-control@example.com').access_granted, 1);

    await grantKeepsManualFreeRow(port);
    await grantControlFreeNotManual(port);
    await clearManualFreeAfterGrant(port);
    await removeFreeRecomputes(port);
    await whopStatusWrittenOnEveryEvent(port);
    migrationIsAdditiveAndIdempotent();

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
