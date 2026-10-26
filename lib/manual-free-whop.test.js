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
// Whop v1 always sends an envelope timestamp; add one unless the event sets the key
// (set it to undefined to send an event with no time at all).
function postWebhook(port, event, { headerTime } = {}) {
  const id = 'msg_manualfree_' + (++msgN);
  const timestamp = headerTime || new Date();
  const body = event && typeof event === 'object' && !('timestamp' in event) ? { ...event, timestamp: timestamp.toISOString() } : event;
  const payload = JSON.stringify(body);
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
  assert.strictEqual(row.access_granted, 1, `${label}: Remove free keeps access_granted 1`);
  const me = await meStatus(port, email);
  const login = await loginStatus(port, email);
  if (expectAccess) {
    assert.strictEqual(me.status, 200, `${label}: /api/me 200 (got ${me.status} ${me.raw})`);
    assert.strictEqual(JSON.parse(me.raw).status, expectStatus, `${label}: /api/me status`);
    assert.strictEqual(login.status, 200, `${label}: /api/login 200 (got ${login.status} ${login.raw})`);
  } else {
    assert.strictEqual(me.status, 403, `${label}: /api/me 403 (got ${me.status} ${me.raw})`);
    assert.strictEqual(JSON.parse(me.raw).error, 'Subscription required or trial expired.', `${label}: /api/me 403 message`);
    assert.strictEqual(login.status, 403, `${label}: /api/login 403 (got ${login.status} ${login.raw})`);
    assert.strictEqual(JSON.parse(login.raw).error, 'Account access has been revoked or trial expired.', `${label}: /api/login 403 message`);
  }
  // No bounce: /api/me and /api/login always agree.
  assert.strictEqual(me.status === 200, login.status === 200, `${label}: /api/me and /api/login agree`);
  const lines = captured.slice(from);
  assert.deepStrictEqual(lines.filter((l) => l.includes('[WHOP EMAIL to') || l.includes('[MAGIC LINK for')), [], `${label}: no mail on Remove free`);
  return row;
}

// Remove free must fail safe: 409, row unchanged, access unchanged, no mail.
async function removeFreeRefused(port, email, label, pattern) {
  const before = fullRow(email);
  const meBefore = (await meStatus(port, email)).status;
  const from = captured.length;
  const res = await setAccess(port, email, { access_granted: true, manual_free: false });
  assert.strictEqual(res.status, 409, `${label}: Remove free refused (got ${res.status} ${res.raw})`);
  const error = JSON.parse(res.raw).error;
  assert.ok(pattern.test(error), `${label}: 409 text ${error}`);
  assert.ok(/Free forever is unchanged/.test(error), `${label}: 409 says free forever is unchanged`);
  assert.deepStrictEqual(fullRow(email), before, `${label}: row unchanged`);
  assert.strictEqual((await meStatus(port, email)).status, meBefore, `${label}: access unchanged`);
  assert.deepStrictEqual(captured.slice(from).filter((l) => l.includes('[WHOP EMAIL to') || l.includes('[MAGIC LINK for')), [], `${label}: no mail`);
  return error;
}
const UNCLEAR = /Whop membership state for this account is unclear/;

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
  // A payment with no membership object says nothing about membership status: unclear, refused.
  seedManualFree('f7-live-emailonly@example.com', { status: 'canceled' });
  await postWebhook(port, { type: 'payment.succeeded', data: { email: 'f7-live-emailonly@example.com' } });
  assert.strictEqual(fullRow('f7-live-emailonly@example.com').status, 'canceled', 'email only payment.succeeded leaves manual_free status');
  assert.strictEqual(fullRow('f7-live-emailonly@example.com').whop_status, 'unknown', 'email only payment is not a membership status');
  await removeFreeRefused(port, 'f7-live-emailonly@example.com', 'email only payment.succeeded is unclear', UNCLEAR);

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
  // past_due is not an unambiguous dead state (Whop may still retry): refused.
  seedManualFree('f7-past-due@example.com', { status: 'free' });
  await postWebhook(port, mem('membership.activated', 'mem_f7pd', 'active', 'f7-past-due@example.com'));
  await postWebhook(port, { type: 'payment.failed', data: { id: 'pay_f7pd', membership: { id: 'mem_f7pd' }, user: { email: 'f7-past-due@example.com' }, plan: { id: PLAN } } });
  assert.strictEqual(fullRow('f7-past-due@example.com').whop_status, 'past_due');
  assert.strictEqual(fullRow('f7-past-due@example.com').status, 'free', 'payment.failed leaves manual_free status');
  await removeFreeRefused(port, 'f7-past-due@example.com', 'past_due is refused', /failed payment that may still be retried/);
  // payment.failed with no membership id cannot be matched to the stored membership: unclear.
  seedManualFree('f7-past-due-noid@example.com', { status: 'free' });
  await postWebhook(port, mem('membership.activated', 'mem_f7pdn', 'active', 'f7-past-due-noid@example.com'));
  await postWebhook(port, { type: 'payment.failed', data: { id: 'pay_f7pdn', user: { email: 'f7-past-due-noid@example.com' }, plan: { id: PLAN } } });
  assert.strictEqual(fullRow('f7-past-due-noid@example.com').whop_status, 'unknown');
  await removeFreeRefused(port, 'f7-past-due-noid@example.com', 'payment.failed without a membership id is unclear', UNCLEAR);
  // Whop trialing with no Whop trial end: the row trial_end is not used, refused.
  seedManualFree('f7-trial-over@example.com', { status: 'trialing', trialEnd: PAST });
  await postWebhook(port, mem('membership.went_valid', 'mem_f7to', 'trialing', 'f7-trial-over@example.com'));
  await removeFreeRefused(port, 'f7-trial-over@example.com', 'whop trialing with no Whop trial end', /trial with no end date/);
  seedManualFree('f7-canceled-null@example.com', { status: 'canceled' });
  assert.strictEqual(fullRow('f7-canceled-null@example.com').whop_status, null);
  await removeFree(port, 'f7-canceled-null@example.com', 'canceled with whop_status null must pay', { expectStatus: 'canceled', expectAccess: false });
  seedManualFree('f7-active-null@example.com', { status: 'active' });
  await removeFree(port, 'f7-active-null@example.com', 'status active but whop_status null must pay', { expectStatus: 'canceled', expectAccess: false });

  // Admin access toggle is respected on Remove free (Revoke stays revoked).
  seedManualFree('f7-revoked-payer@example.com', { status: 'free', access: 0 });
  db.prepare(`UPDATE users SET whop_status = 'active', whop_event_at = ? WHERE email = ?`).run(T(1), 'f7-revoked-payer@example.com');
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
    ['membership.created no status', (e) => ({ type: 'membership.created', data: { id: 'mem_ws3', plan: { id: PLAN }, user: { email: e } } }), 'unknown'],
    ['membership.created drafted', (e) => mem('membership.created', 'mem_ws3d', 'drafted', e), 'unknown'],
    ['membership.activated past_due', (e) => mem('membership.activated', 'mem_ws4', 'past_due', e), 'past_due'],
    ['membership.activated unresolved', (e) => mem('membership.activated', 'mem_ws5', 'unresolved', e), 'past_due'],
    ['membership.activated expired', (e) => mem('membership.activated', 'mem_ws6', 'expired', e), 'canceled'],
    ['membership.deactivated', (e) => mem('membership.deactivated', 'mem_ws7', 'active', e), 'canceled'],
    ['membership.went_invalid', (e) => mem('membership.went_invalid', 'mem_ws8', 'active', e), 'canceled'],
    ['membership.canceled', (e) => mem('membership.canceled', 'mem_ws9', 'active', e), 'canceled'],
    ['membership.trial_ending_soon', (e) => mem('membership.trial_ending_soon', 'mem_ws10', 'trialing', e, { renewal_period_end: FUTURE }), 'trialing'],
    ['payment.failed', (e) => ({ type: 'payment.failed', data: { id: 'pay_ws11', user: { email: e }, plan: { id: PLAN } } }), 'past_due'],
    ['payment.succeeded membership', (e) => ({ type: 'payment.succeeded', data: { id: 'pay_ws12', membership: { id: 'mem_ws12', status: 'active', plan: { id: PLAN }, user: { email: e } } } }), 'active'],
    ['payment.succeeded email only', (e) => ({ type: 'payment.succeeded', data: { email: e } }), 'unknown'],
    ['payment.succeeded flat pay_', (e) => ({ type: 'payment.succeeded', data: { id: 'pay_ws13', status: 'paid', plan: { id: PLAN }, user: { email: e } } }), 'unknown'],
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
  const { ensureWhopStatusColumn, ensureWhopTrialEndColumn, ensureWhopEventAtColumn } = require('./security');
  const NEW_COLS = ['whop_status', 'whop_trial_end', 'whop_event_at'];
  const stripNew = (r) => Object.fromEntries(Object.entries(r).filter(([k]) => !NEW_COLS.includes(k)));
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
    for (const [name, ensure] of [['whop_status', ensureWhopStatusColumn], ['whop_trial_end', ensureWhopTrialEndColumn], ['whop_event_at', ensureWhopEventAtColumn]]) {
      assert.strictEqual(ensure(d), true, `first run adds ${name}`);
      assert.strictEqual(ensure(d), false, `second run of ${name} is a no op`);
      const cols = d.prepare('PRAGMA table_info(users)').all().filter((c) => c.name === name);
      assert.strictEqual(cols.length, 1, `exactly one ${name} column`);
      assert.strictEqual(cols[0].type, 'TEXT', `${name} is TEXT`);
      assert.strictEqual(cols[0].notnull, 0, `${name} is nullable`);
      assert.strictEqual(cols[0].dflt_value, null, `${name} has no default`);
    }
    const after = d.prepare('SELECT * FROM users ORDER BY id').all();
    assert.deepStrictEqual(after.map(stripNew), before, 'existing rows untouched');
    assert.ok(after.every((r) => NEW_COLS.every((c) => r[c] === null)), 'existing rows get NULL in every new column');
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
      const allCols = d3.prepare('PRAGMA table_info(users)').all();
      for (const name of NEW_COLS) {
        assert.strictEqual(allCols.filter((c) => c.name === name).length, 1, `server start ${run}: one ${name} column`);
      }
      const rows = d3.prepare('SELECT * FROM users ORDER BY id').all();
      assert.deepStrictEqual(rows.map(stripNew), startBefore, `server start ${run}: rows untouched`);
      assert.ok(rows.every((r) => NEW_COLS.every((c) => r[c] === null)), `server start ${run}: NULL in every new column`);
      d3.close();
    }
  } finally {
    for (const f of files) { try { fs.unlinkSync(f); } catch (e) {} }
  }
}


const IN_7_DAYS = () => new Date(Date.now() + 7 * 86400000).toISOString();
const T = (minute) => new Date(Date.UTC(2026, 9, 1, 0, minute)).toISOString();

function magicVerify(port, email) {
  const token = 'unit-magic-' + email;
  db.prepare('INSERT OR REPLACE INTO magic_tokens (token, email, expires_at) VALUES (?, ?, ?)').run(token, email, new Date(Date.now() + 600000).toISOString());
  return request(port, { method: 'GET', path: '/api/verify-magic?token=' + encodeURIComponent(token) });
}

async function liveTrialKeepsAccess(port) {
  // QA A row R03: activated while trialing, row trial_end NULL, Whop trial end in 7 days.
  const r03 = 'fix-r03-activated-trialing@example.com';
  const end = IN_7_DAYS();
  seedManualFree(r03, { status: 'free' });
  await postWebhook(port, mem('membership.activated', 'mem_r03', 'trialing', r03, { renewal_period_end: end }));
  assert.strictEqual(fullRow(r03).whop_trial_end, end, 'R03: whop_trial_end recorded on manual_free row');
  assert.strictEqual(fullRow(r03).trial_end, null, 'R03: manual_free trial_end untouched by the grant');
  const kept = await removeFree(port, r03, 'R03 live Whop trial keeps access', { expectStatus: 'trialing', expectAccess: true });
  assert.strictEqual(kept.trial_end, end, 'R03: trial_end set to the Whop trial end on Remove free');

  // Newer API pin: current_period_end instead of renewal_period_end.
  const pin = 'fix-r03-current-period@example.com';
  seedManualFree(pin, { status: 'free' });
  await postWebhook(port, mem('membership.went_valid', 'mem_r03b', 'trialing', pin, { current_period_end: end }));
  await removeFree(port, pin, 'live Whop trial from current_period_end keeps access', { expectStatus: 'trialing', expectAccess: true });

  // QA A row R05: trial_ending_soon only.
  const r05 = 'fix-r05-trial-ending-only@example.com';
  seedManualFree(r05, { status: 'free' });
  await postWebhook(port, mem('membership.trial_ending_soon', 'mem_r05', 'trialing', r05, { renewal_period_end: end }));
  assert.strictEqual(fullRow(r05).whop_status, 'trialing');
  assert.strictEqual(fullRow(r05).whop_trial_end, end, 'R05: trial_ending_soon records whop_trial_end');
  await removeFree(port, r05, 'R05 trial_ending_soon only keeps access', { expectStatus: 'trialing', expectAccess: true });

  // QA A row R18: active, then trial_ending_soon. A trial notice never downgrades active.
  const r18 = 'fix-r18-active-then-trial-ending@example.com';
  seedManualFree(r18, { status: 'free' });
  await postWebhook(port, mem('membership.activated', 'mem_r18', 'active', r18));
  await postWebhook(port, mem('membership.trial_ending_soon', 'mem_r18', 'trialing', r18, { renewal_period_end: end }));
  assert.strictEqual(fullRow(r18).whop_status, 'active', 'R18: trial notice does not downgrade active');
  await removeFree(port, r18, 'R18 active then trial_ending_soon keeps access', { expectStatus: 'active', expectAccess: true });

  // Ended Whop trial (end in the past) still must pay; whop_trial_end cleared when Whop says active.
  const ended = 'fix-trial-ended@example.com';
  seedManualFree(ended, { status: 'free' });
  await postWebhook(port, mem('membership.went_valid', 'mem_ended', 'trialing', ended, { renewal_period_end: PAST }));
  await removeFree(port, ended, 'Whop trial already ended must pay', { expectStatus: 'canceled', expectAccess: false });
  const conv = 'fix-trial-converted@example.com';
  seedManualFree(conv, { status: 'free' });
  await postWebhook(port, mem('membership.went_valid', 'mem_conv', 'trialing', conv, { renewal_period_end: end }));
  await postWebhook(port, mem('membership.activated', 'mem_conv', 'active', conv));
  assert.strictEqual(fullRow(conv).whop_trial_end, null, 'whop_trial_end cleared once Whop reports active');

  // A brand new user from Whop gets whop_status and whop_trial_end on INSERT.
  const fresh = 'fix-new-whop-user@example.com';
  await postWebhook(port, mem('membership.activated', 'mem_fresh', 'trialing', fresh, { renewal_period_end: end }));
  assert.strictEqual(fullRow(fresh).whop_status, 'trialing', 'new user INSERT writes whop_status');
  assert.strictEqual(fullRow(fresh).whop_trial_end, end, 'new user INSERT writes whop_trial_end');
  assert.ok(fullRow(fresh).whop_event_at, 'new user records whop_event_at');

  // trial_end == now boundary: strict, the same as userHasAccess, login and requireAuth (now < trial_end).
  const { removeFreeDecision } = require('./security');
  const now = new Date('2026-10-26T15:00:00.000Z');
  const row = { whop_status: 'trialing', whop_trial_end: now.toISOString(), whop_event_at: T(1), trial_end: null };
  assert.strictEqual(removeFreeDecision(row, now).status, 'canceled', 'trial end equal to now is over');
  assert.strictEqual(removeFreeDecision(row, new Date(now.getTime() - 1)).status, 'trialing', 'trial end 1 ms after now is live');
  assert.ok(removeFreeDecision({ ...row, whop_trial_end: null, trial_end: FUTURE }, now).blocked, 'no Whop trial end is refused; the row trial_end is not used');
  assert.strictEqual(removeFreeDecision({ ...row, whop_trial_end: PAST, trial_end: FUTURE }, now).status, 'canceled', 'Whop trial end wins over an old row trial_end');
  assert.ok(removeFreeDecision({ ...row, whop_status: 'active', whop_event_at: null }, now).blocked, 'no usable event time is refused');
  assert.ok(removeFreeDecision({ ...row, whop_status: 'active', whop_event_at: 'garbage' }, now).blocked, 'garbage event time is refused');
  assert.ok(removeFreeDecision({ ...row, whop_status: 'drafted' }, now).blocked, 'unrecognized whop_status is refused');
  assert.ok(removeFreeDecision({ ...row, whop_status: 'canceled', stripe_subscription_id: 'sub_1' }, now).blocked, 'Stripe subscription on record is refused');
  assert.strictEqual(removeFreeDecision({ ...row, whop_status: 'canceled' }, now).status, 'canceled', 'Whop canceled must pay');
  assert.strictEqual(removeFreeDecision({ whop_status: null, trial_end: null }, now).status, 'canceled', 'never a Whop or Stripe member must pay');
}

async function legacyNullWithMembershipRefused(port) {
  for (const [label, col] of [['whop_membership_id', 'mem_legacy'], ['whop_member_id', 'mber_legacy']]) {
    const email = `fix-legacy-${label.replace(/_/g, '-')}@example.com`;
    seedManualFree(email, { status: 'active' });
    db.prepare(`UPDATE users SET ${label} = ? WHERE email = ?`).run(col, email);
    const before = fullRow(email);
    const from = captured.length;
    const res = await setAccess(port, email, { access_granted: true, manual_free: false });
    assert.strictEqual(res.status, 409, `legacy ${label}: Remove free refused (got ${res.status})`);
    assert.ok(/no Whop status recorded/.test(JSON.parse(res.raw).error), `legacy ${label}: admin UI gets a clear error`);
    assert.deepStrictEqual(fullRow(email), before, `legacy ${label}: row unchanged, manual_free kept`);
    assert.strictEqual((await meStatus(port, email)).status, 200, `legacy ${label}: still has access`);
    assert.deepStrictEqual(mailTo(captured.slice(from), email), [], `legacy ${label}: no mail`);
  }
  // Once a Whop event records the state, Remove free works.
  const email = 'fix-legacy-whop-membership-id@example.com';
  await postWebhook(port, { type: 'payment.succeeded', data: { id: 'pay_legacy', membership: { id: 'mem_legacy', status: 'active', plan: { id: PLAN }, user: { email } } } });
  await removeFree(port, email, 'legacy payer after a Whop event keeps access', { expectStatus: 'active', expectAccess: true });
  // Revoke and Grant on such a row (manual_free unchanged) are not refused.
  const other = 'fix-legacy-whop-member-id@example.com';
  const rv = await setAccess(port, other, { access_granted: false, manual_free: true });
  assert.strictEqual(rv.status, 200, 'Revoke without Remove free is not refused');
  // No Whop ids and NULL whop_status: still must pay (intended).
  seedManualFree('fix-null-no-ids@example.com', { status: 'free' });
  await removeFree(port, 'fix-null-no-ids@example.com', 'NULL whop_status and no Whop ids must pay', { expectStatus: 'canceled', expectAccess: false });
}

async function eventsAreOrdered(port) {
  // Stale deactivated after activated (same membership, older updated_at).
  const a = 'fix-order-stale-deact@example.com';
  seedManualFree(a, { status: 'free' });
  await postWebhook(port, mem('membership.activated', 'mem_oa', 'active', a, { updated_at: T(20) }));
  await postWebhook(port, mem('membership.deactivated', 'mem_oa', 'active', a, { updated_at: T(10) }));
  assert.strictEqual(fullRow(a).whop_status, 'active', 'stale deactivated ignored');
  assert.strictEqual(fullRow(a).whop_event_at, T(20), 'whop_event_at keeps the newest event time');
  await removeFree(port, a, 'stale deactivated after activated keeps access', { expectStatus: 'active', expectAccess: true });

  // Deactivation of an old membership while a different one is live.
  const b = 'fix-order-other-membership@example.com';
  seedManualFree(b, { status: 'free' });
  await postWebhook(port, mem('membership.activated', 'mem_ob_new', 'active', b, { updated_at: T(20) }));
  await postWebhook(port, mem('membership.deactivated', 'mem_ob_old', 'active', b, { updated_at: T(30) }));
  assert.strictEqual(fullRow(b).whop_status, 'unknown', 'deactivation of another membership makes the shadow unclear');
  assert.strictEqual(fullRow(b).whop_membership_id, 'mem_ob_new');
  await removeFreeRefused(port, b, 'old membership deactivated is refused, not cut and not kept', UNCLEAR);
  await postWebhook(port, mem('membership.went_valid', 'mem_ob_new', 'active', b, { updated_at: T(40) }));
  await removeFree(port, b, 'next update for the live membership clears it', { expectStatus: 'active', expectAccess: true });

  // payment.failed redelivered after a later success.
  const c = 'fix-order-failed-retry@example.com';
  seedManualFree(c, { status: 'free' });
  const failed = { type: 'payment.failed', data: { id: 'pay_oc1', updated_at: T(10), membership: { id: 'mem_oc' }, user: { email: c }, plan: { id: PLAN } } };
  await postWebhook(port, failed);
  await postWebhook(port, { type: 'payment.succeeded', data: { id: 'pay_oc2', updated_at: T(20), membership: { id: 'mem_oc', status: 'active', plan: { id: PLAN }, user: { email: c } } } });
  await postWebhook(port, failed);
  assert.strictEqual(fullRow(c).whop_status, 'active', 'payment.failed retry after success ignored');
  await removeFree(port, c, 'payment.failed retry after success keeps access', { expectStatus: 'active', expectAccess: true });

  // trial_ending_soon delivered after the trial converted (envelope timestamp older).
  const d = 'fix-order-trial-notice-late@example.com';
  seedManualFree(d, { status: 'free' });
  await postWebhook(port, mem('membership.went_valid', 'mem_od', 'trialing', d, { updated_at: T(0), renewal_period_end: T(60) }));
  await postWebhook(port, { type: 'payment.succeeded', data: { id: 'pay_od', updated_at: T(70), membership: { id: 'mem_od', status: 'active', plan: { id: PLAN }, user: { email: d } } } });
  await postWebhook(port, { type: 'membership.trial_ending_soon', timestamp: T(50), data: { id: 'mem_od', status: 'trialing', plan: { id: PLAN }, user: { email: d }, renewal_period_end: T(60) } });
  assert.strictEqual(fullRow(d).whop_status, 'active', 'late trial notice ignored');
  await removeFree(port, d, 'trial notice after conversion keeps access', { expectStatus: 'active', expectAccess: true });

  // Control: a newer deactivation of the live membership still applies.
  const e = 'fix-order-real-cancel@example.com';
  seedManualFree(e, { status: 'free' });
  await postWebhook(port, mem('membership.activated', 'mem_oe', 'active', e, { updated_at: T(10) }));
  await postWebhook(port, mem('membership.deactivated', 'mem_oe', 'active', e, { updated_at: T(20) }));
  assert.strictEqual(fullRow(e).whop_status, 'canceled', 'newer deactivation applies');
  await removeFree(port, e, 'real cancel must pay', { expectStatus: 'canceled', expectAccess: false });

  // A new live membership replaces a stored live one.
  const f = 'fix-order-new-membership@example.com';
  seedManualFree(f, { status: 'free' });
  await postWebhook(port, mem('membership.activated', 'mem_of_1', 'past_due', f, { updated_at: T(10) }));
  await postWebhook(port, mem('membership.activated', 'mem_of_2', 'active', f, { updated_at: T(20) }));
  assert.strictEqual(fullRow(f).whop_status, 'active', 'new live membership applies');
  assert.strictEqual(fullRow(f).whop_membership_id, 'mem_of_2');
  await removeFree(port, f, 'membership switch to a live membership keeps access', { expectStatus: 'active', expectAccess: true });

  // Normal paid user: ordering never applies to normal columns; a deactivation cancels as on base.
  insertRaw('fix-order-paid@example.com', { status: 'trialing', access: 1, manualFree: 0, trialEnd: FUTURE });
  await postWebhook(port, mem('membership.activated', 'mem_og', 'active', 'fix-order-paid@example.com', { updated_at: T(20) }));
  await postWebhook(port, mem('membership.deactivated', 'mem_og', 'active', 'fix-order-paid@example.com', { updated_at: T(10) }));
  assert.strictEqual(userRow('fix-order-paid@example.com').status, 'canceled', 'normal user deactivation is not skipped (base behavior)');
  assert.strictEqual(userRow('fix-order-paid@example.com').access_granted, 0);
  assert.strictEqual(fullRow('fix-order-paid@example.com').whop_status, 'active', 'only the shadow ignores the stale event');

  // Unit: event time sources, parsing, cap, and shadow rules.
  const { whopShadowEventTime: et, whopIsoTime, whopShadowUpdate, WHOP_EVENT_SKEW_MS } = require('./security');
  const hdr = String(Math.floor(Date.parse('2026-10-26T00:00:00.000Z') / 1000));
  assert.strictEqual(WHOP_EVENT_SKEW_MS, 5 * 60 * 1000, 'skew is 5 minutes');
  assert.strictEqual(et('membership.activated', { timestamp: T(5), data: {} }, { updated_at: T(9) }, hdr), T(9));
  assert.strictEqual(et('payment.succeeded', { data: {} }, { membership: { updated_at: T(8) } }, hdr), T(8));
  assert.strictEqual(et('membership.activated', { timestamp: T(5), data: {} }, {}, hdr), T(5));
  assert.strictEqual(et('membership.trial_ending_soon', { timestamp: T(5), data: {} }, { updated_at: T(9) }, hdr), T(5));
  const bare = { id: 'mem_x' };
  assert.strictEqual(et('membership.activated', bare, bare, hdr), null, 'no time in payload: no event time (receipt time is never used)');
  assert.strictEqual(et('membership.activated', {}, { updated_at: T(9) }, undefined), null, 'no header: no usable time');
  assert.strictEqual(et('membership.activated', {}, { updated_at: '2099-01-01T00:00:00Z' }, hdr), '2026-10-26T00:05:00.000Z', 'body time capped at header plus 5 minutes');
  assert.strictEqual(et('membership.activated', {}, { updated_at: '2026-10-26T00:04:59.000Z' }, hdr), '2026-10-26T00:04:59.000Z', 'inside the skew is kept');
  const sec = Math.floor(Date.parse(T(7)) / 1000);
  assert.strictEqual(whopIsoTime(sec), T(7), 'epoch seconds number');
  assert.strictEqual(whopIsoTime(String(sec)), T(7), 'epoch seconds string');
  assert.strictEqual(whopIsoTime(sec * 1000), T(7), 'epoch ms number');
  assert.strictEqual(whopIsoTime(String(sec * 1000)), T(7), 'epoch ms string');
  assert.strictEqual(whopIsoTime(T(7)), T(7), 'ISO');
  for (const bad of ['garbage', '2026', 'Oct 1 2026', '', null, true, {}, NaN, -1]) {
    assert.strictEqual(whopIsoTime(bad), null, `unusable time ${JSON.stringify(bad)}`);
  }
  const prev = { whop_status: 'active', whop_event_at: T(5), whop_membership_id: 'mem_a' };
  assert.strictEqual(whopShadowUpdate(prev, { status: 'canceled', membershipId: 'mem_a', eventAt: T(4) }).patch, null, 'older event is stale');
  assert.strictEqual(whopShadowUpdate(prev, { status: 'canceled', membershipId: 'mem_a', eventAt: T(5) }).patch.whop_status, 'canceled', 'equal time applies');
  assert.strictEqual(whopShadowUpdate(prev, { status: 'canceled', membershipId: 'mem_b', eventAt: T(6) }).patch.whop_status, 'unknown', 'other membership, not live: unknown');
  assert.strictEqual(whopShadowUpdate(prev, { status: 'active', membershipId: 'mem_b', eventAt: T(6) }).patch.whop_status, 'active', 'other membership, live: switch applies');
  assert.strictEqual(whopShadowUpdate({ ...prev, whop_membership_id: 'pay_1' }, { status: 'canceled', membershipId: 'mem_a', eventAt: T(6) }).patch.whop_status, 'unknown', 'stored pay_ id is not a membership reference');
  const noTime = whopShadowUpdate(prev, { status: 'canceled', membershipId: 'mem_a', eventAt: null }).patch;
  assert.deepStrictEqual(noTime, { whop_status: 'unknown', whop_trial_end: null, whop_event_at: T(5) }, 'no time: unknown, event time unchanged');
}

async function emailOnlyPlanCheck(port) {
  const foreign = { plan: { id: 'plan_NOTTWIC_fake0001' } };
  seedManualFree('fix-eo-foreign-mf@example.com', { status: 'free' });
  const before = fullRow('fix-eo-foreign-mf@example.com');
  await postWebhook(port, { type: 'payment.succeeded', data: { email: 'fix-eo-foreign-mf@example.com', ...foreign } });
  assert.deepStrictEqual(fullRow('fix-eo-foreign-mf@example.com'), before, 'foreign email only payment changes nothing on manual_free row');
  await removeFree(port, 'fix-eo-foreign-mf@example.com', 'foreign email only payment does not keep access', { expectStatus: 'canceled', expectAccess: false });
  insertRaw('fix-eo-foreign-paid@example.com', { status: 'canceled', access: 0, manualFree: 0, trialEnd: null });
  const before2 = fullRow('fix-eo-foreign-paid@example.com');
  await postWebhook(port, { type: 'payment.succeeded', data: { email: 'fix-eo-foreign-paid@example.com', plan_id: 'plan_NOTTWIC_fake0001' } });
  assert.deepStrictEqual(fullRow('fix-eo-foreign-paid@example.com'), before2, 'foreign email only payment does not activate a normal user');
  insertRaw('fix-eo-twic-paid@example.com', { status: 'canceled', access: 0, manualFree: 0, trialEnd: null });
  await postWebhook(port, { type: 'payment.succeeded', data: { email: 'fix-eo-twic-paid@example.com', plan: { id: PLAN } } });
  assert.strictEqual(userRow('fix-eo-twic-paid@example.com').status, 'active', 'Twic plan email only payment still activates');
}

async function magicLinkMatchesAccess(port) {
  seedManualFree('fix-magic-cut@example.com', { status: 'free' });
  await removeFree(port, 'fix-magic-cut@example.com', 'cut off before magic link', { expectStatus: 'canceled', expectAccess: false });
  const cut = await magicVerify(port, 'fix-magic-cut@example.com');
  assert.strictEqual(cut.status, 403, `magic link for a cut off user is 403 (got ${cut.status})`);
  assert.ok(!JSON.parse(cut.raw).token, 'no token for a cut off user');
  insertRaw('fix-magic-trial-over@example.com', { status: 'trialing', access: 1, manualFree: 0, trialEnd: PAST });
  assert.strictEqual((await magicVerify(port, 'fix-magic-trial-over@example.com')).status, 403, 'magic link 403 for an expired trial, like login');
  insertRaw('fix-magic-ok@example.com', { status: 'active', access: 1, manualFree: 0, trialEnd: null });
  const ok = await magicVerify(port, 'fix-magic-ok@example.com');
  assert.strictEqual(ok.status, 200, 'magic link still works for an active user');
  assert.ok(JSON.parse(ok.raw).token, 'active user gets a token');
  seedManualFree('fix-magic-free@example.com', { status: 'free' });
  assert.strictEqual((await magicVerify(port, 'fix-magic-free@example.com')).status, 200, 'magic link still works for free forever');
}

async function shadowRules(port) {
  // Membership switch: a new live membership applies; a late cancel of the old one is unclear.
  const sw = 'sh-switch@example.com';
  seedManualFree(sw, { status: 'free' });
  await postWebhook(port, mem('membership.activated', 'mem_swa', 'active', sw, { updated_at: T(10) }));
  await postWebhook(port, mem('membership.activated', 'mem_swb', 'trialing', sw, { updated_at: T(20), renewal_period_end: FUTURE }));
  assert.strictEqual(fullRow(sw).whop_status, 'trialing', 'switch: the new live membership activation applies');
  assert.strictEqual(fullRow(sw).whop_trial_end, FUTURE, 'switch: trial end from the new membership');
  await postWebhook(port, mem('membership.deactivated', 'mem_swa', 'active', sw, { updated_at: T(30) }));
  assert.strictEqual(fullRow(sw).whop_status, 'unknown', 'switch: late cancel of the old membership is unclear');
  await removeFreeRefused(port, sw, 'switch then old cancel', UNCLEAR);
  await postWebhook(port, mem('membership.deactivated', 'mem_swb', 'active', sw, { updated_at: T(40) }));
  await removeFree(port, sw, 'switch then cancel of the current membership must pay', { expectStatus: 'canceled', expectAccess: false });

  // Epoch seconds trial end (number and string) is read as seconds.
  const endMs = Date.now() + 5 * 86400000;
  const endIso = new Date(Math.floor(endMs / 1000) * 1000).toISOString();
  for (const [label, value] of [['number', Math.floor(endMs / 1000)], ['string', String(Math.floor(endMs / 1000))]]) {
    const email = `sh-epoch-${label}@example.com`;
    seedManualFree(email, { status: 'free' });
    await postWebhook(port, mem('membership.went_valid', 'mem_ep_' + label, 'trialing', email, { current_period_end: value }));
    assert.strictEqual(fullRow(email).whop_trial_end, endIso, `epoch seconds ${label}: trial end parsed as seconds`);
    const kept = await removeFree(port, email, `epoch seconds ${label} trial keeps access`, { expectStatus: 'trialing', expectAccess: true });
    assert.strictEqual(kept.trial_end, endIso, `epoch seconds ${label}: trial_end set to the Whop trial end`);
  }

  // Far future body time is capped, so a later real cancel still applies.
  const ff = 'sh-far-future@example.com';
  seedManualFree(ff, { status: 'free' });
  const h1 = new Date();
  await postWebhook(port, mem('membership.activated', 'mem_ff', 'active', ff, { updated_at: '2099-01-01T00:00:00.000Z' }), { headerTime: h1 });
  const capped = Date.parse(fullRow(ff).whop_event_at);
  const h1s = Math.floor(h1.getTime() / 1000) * 1000;
  assert.strictEqual(capped, h1s + 5 * 60 * 1000, 'far future event time capped at header plus 5 minutes');
  await postWebhook(port, mem('membership.deactivated', 'mem_ff', 'active', ff, { updated_at: '2099-06-01T00:00:00.000Z' }), { headerTime: new Date(h1s + 2000) });
  assert.strictEqual(fullRow(ff).whop_status, 'canceled', 'later cancel applies after a far future activation');
  await removeFree(port, ff, 'far future activation then cancel must pay', { expectStatus: 'canceled', expectAccess: false });

  // Event with no time at all: unclear, refused.
  const nt = 'sh-no-time@example.com';
  seedManualFree(nt, { status: 'free' });
  await postWebhook(port, { ...mem('membership.activated', 'mem_nt', 'active', nt), timestamp: undefined });
  assert.strictEqual(fullRow(nt).whop_status, 'unknown', 'no time: unknown');
  assert.strictEqual(fullRow(nt).whop_event_at, null, 'no time: no event time stored, receipt time not used');
  await removeFreeRefused(port, nt, 'event with no time', UNCLEAR);
  // A timed cancel after an untimed event is not blocked by it.
  await postWebhook(port, mem('membership.deactivated', 'mem_nt', 'active', nt, { updated_at: T(10) }));
  await removeFree(port, nt, 'timed cancel after an untimed event must pay', { expectStatus: 'canceled', expectAccess: false });

  // pay_ only payment: never a membership id; the real cancel after it is unclear, never dropped as active.
  const pp = 'sh-pay-only@example.com';
  seedManualFree(pp, { status: 'free' });
  await postWebhook(port, mem('membership.activated', 'mem_pp', 'active', pp, { updated_at: T(10) }));
  await postWebhook(port, { type: 'payment.succeeded', data: { id: 'pay_pp', status: 'paid', plan: { id: PLAN }, user: { email: pp }, updated_at: T(20) } });
  assert.strictEqual(fullRow(pp).whop_status, 'unknown', 'pay_ only payment is not a membership state');
  await removeFreeRefused(port, pp, 'pay_ only payment', UNCLEAR);
  await postWebhook(port, mem('membership.deactivated', 'mem_pp', 'active', pp, { updated_at: T(30) }));
  assert.notStrictEqual(fullRow(pp).whop_status, 'active', 'real cancel after a pay_ payment never leaves the shadow active');
  await removeFreeRefused(port, pp, 'cancel after pay_ id stored by the normal handler', UNCLEAR);

  // Whop v1 payment shape: user on the payment, membership object without user.
  const v1 = 'sh-v1-payment@example.com';
  seedManualFree(v1, { status: 'free' });
  await postWebhook(port, { type: 'payment.succeeded', data: { id: 'pay_v1', user: { email: v1 }, plan: { id: PLAN }, membership: { id: 'mem_v1', status: 'active' }, updated_at: T(10) } });
  assert.strictEqual(fullRow(v1).whop_status, 'active', 'v1 payment shape records the membership status');
  await removeFree(port, v1, 'v1 payment shape member keeps access', { expectStatus: 'active', expectAccess: true });

  // Unknown membership status: unclear.
  const dr = 'sh-drafted@example.com';
  seedManualFree(dr, { status: 'free' });
  await postWebhook(port, mem('membership.created', 'mem_dr', 'drafted', dr));
  await removeFreeRefused(port, dr, 'drafted membership', UNCLEAR);

  // metadata.email never moves another account's shadow.
  const md = 'sh-metadata@example.com';
  seedManualFree(md, { status: 'free' });
  await postWebhook(port, mem('membership.activated', 'mem_md', 'active', md, { updated_at: T(10) }));
  await postWebhook(port, { type: 'membership.deactivated', data: { id: 'mem_other', status: 'active', plan: { id: PLAN }, metadata: { email: md }, updated_at: T(20) } });
  assert.strictEqual(fullRow(md).whop_status, 'active', 'metadata.email event does not touch the shadow');

  // A Stripe subscription on record: refused even when Whop says canceled.
  const st = 'sh-stripe@example.com';
  seedManualFree(st, { status: 'free' });
  db.prepare('UPDATE users SET stripe_customer_id = ?, stripe_subscription_id = ? WHERE email = ?').run('cus_sh', 'sub_sh', st);
  await postWebhook(port, mem('membership.activated', 'mem_st', 'active', st, { updated_at: T(10) }));
  await postWebhook(port, mem('membership.deactivated', 'mem_st', 'active', st, { updated_at: T(20) }));
  await removeFreeRefused(port, st, 'Stripe subscription on record', /Stripe subscription on record/);
  const stNoWhop = 'sh-stripe-only@example.com';
  seedManualFree(stNoWhop, { status: 'free' });
  db.prepare('UPDATE users SET stripe_subscription_id = ? WHERE email = ?').run('sub_sh2', stNoWhop);
  await removeFreeRefused(port, stNoWhop, 'Stripe subscription, no Whop', /Stripe subscription on record/);
}

// Normal account columns (not the free forever shadow) and mail, compared with base 91cfaa56.
const BASE_COLUMNS = ['status', 'trial_end', 'access_granted', 'manual_free', 'whop_membership_id', 'whop_member_id', 'stripe_customer_id', 'stripe_subscription_id', 'group_name', 'password_hash'];
const FAR = '2099-01-01T00:00:00.000Z';
const DIFF_SCENARIOS = [
  ['stale-deact', [['membership.activated', 'mem_1', 'active', { updated_at: T(20) }], ['membership.deactivated', 'mem_1', 'active', { updated_at: T(10) }]]],
  ['emailonly-after-deact', [['membership.activated', 'mem_1', 'active', { updated_at: T(10) }], ['membership.deactivated', 'mem_1', 'active', { updated_at: T(20) }], ['emailonly', { updated_at: T(15) }]], { normalOnly: true }],
  ['other-membership-deact', [['membership.activated', 'mem_new', 'active', { updated_at: T(20) }], ['membership.deactivated', 'mem_old', 'active', { updated_at: T(30) }]]],
  ['past-due-other-id', [['membership.activated', 'mem_1', 'active', { updated_at: T(10) }], ['membership.activated', 'mem_2', 'past_due', { updated_at: T(20) }]]],
  ['flat-pay-then-cancel', [['membership.activated', 'mem_1', 'active', { updated_at: T(10) }], ['flatpay', { updated_at: T(20) }], ['membership.deactivated', 'mem_1', 'active', { updated_at: T(30) }]]],
  ['untimed-then-older-deact', [['membership.activated', 'mem_1', 'active', { notime: true }], ['membership.deactivated', 'mem_1', 'active', { updated_at: T(10) }]]],
  ['far-future-then-deact', [['membership.activated', 'mem_1', 'active', { updated_at: FAR }], ['membership.deactivated', 'mem_1', 'active', { updated_at: T(10) }]]],
  ['epoch-string-then-deact', [['membership.activated', 'mem_1', 'active', { updated_at: String(Math.floor(Date.parse(T(20)) / 1000)) }], ['membership.deactivated', 'mem_1', 'active', { updated_at: T(10) }]]],
  ['drafted-other-then-deact', [['membership.activated', 'mem_a', 'active', { updated_at: T(10) }], ['membership.created', 'mem_b', 'drafted', { updated_at: T(20) }], ['membership.deactivated', 'mem_a', 'active', { updated_at: T(30) }]]],
  ['metadata-email-then-deact', [['membership.activated', 'mem_v', 'active', { updated_at: T(10) }], ['metadata', 'mem_x', 'active', { updated_at: T(20) }], ['membership.deactivated', 'mem_v', 'active', { updated_at: T(30) }]]],
  ['garbage-time-then-deact', [['membership.activated', 'mem_1', 'active', { updated_at: 'garbage' }], ['membership.deactivated', 'mem_1', 'active', { updated_at: T(10) }]]],
  ['equal-time', [['membership.activated', 'mem_1', 'active', { updated_at: T(10) }], ['membership.deactivated', 'mem_1', 'active', { updated_at: T(10) }]]],
  ['replayed-activation', [['membership.activated', 'mem_1', 'active', { updated_at: T(10) }], ['membership.deactivated', 'mem_1', 'active', { updated_at: T(20) }], ['membership.activated', 'mem_1', 'active', { updated_at: T(10) }]]],
  ['switch-then-old-cancel', [['membership.activated', 'mem_a', 'active', { updated_at: T(10) }], ['membership.activated', 'mem_b', 'active', { updated_at: T(20) }], ['membership.deactivated', 'mem_a', 'active', { updated_at: T(30) }]]],
  ['failed-retry-after-success', [['failed', 'mem_1', { updated_at: T(10) }], ['nestedpay', 'mem_1', 'active', { updated_at: T(20) }], ['failed', 'mem_1', { updated_at: T(10) }]]],
  ['trial-notice-late', [['membership.went_valid', 'mem_1', 'trialing', { updated_at: T(0), renewal_period_end: T(60) }], ['nestedpay', 'mem_1', 'active', { updated_at: T(70) }], ['membership.trial_ending_soon', 'mem_1', 'trialing', { envelope: T(50), renewal_period_end: T(60) }]]],
  ['past-due-then-deact', [['membership.activated', 'mem_1', 'active', { updated_at: T(10) }], ['failed', 'mem_1', { updated_at: T(20) }], ['membership.deactivated', 'mem_1', 'active', { updated_at: T(30) }]]],
  ['trialing-then-active', [['membership.went_valid', 'mem_1', 'trialing', { updated_at: T(10), renewal_period_end: FUTURE }], ['membership.activated', 'mem_1', 'active', { updated_at: T(20) }]]],
  ['new-user', [['membership.activated', 'mem_n', 'trialing', { updated_at: T(10), renewal_period_end: FUTURE }]], { noSeed: true }],
];

function diffEvent(step, email) {
  const [kind] = step;
  const plan = { id: PLAN };
  const timeOf = (o) => (o.notime ? { timestamp: undefined } : o.envelope ? { timestamp: o.envelope } : {});
  if (kind === 'emailonly') return { type: 'payment.succeeded', data: { email, plan, updated_at: step[1].updated_at } };
  if (kind === 'flatpay') return { type: 'payment.succeeded', data: { id: 'pay_diff', status: 'paid', plan, user: { email }, updated_at: step[1].updated_at } };
  if (kind === 'failed') return { type: 'payment.failed', data: { id: 'pay_f', membership: { id: step[1] }, plan, user: { email }, updated_at: step[2].updated_at } };
  if (kind === 'nestedpay') return { type: 'payment.succeeded', data: { id: 'pay_n', updated_at: step[3].updated_at, membership: { id: step[1], status: step[2], plan, user: { email } } } };
  if (kind === 'metadata') return { type: 'membership.activated', data: { id: step[1], status: step[2], plan, metadata: { email }, updated_at: step[3].updated_at } };
  const [type, id, status, o] = step;
  const { notime, envelope, ...extra } = o;
  return { type, ...timeOf(o), data: { id, status, plan, user: { email }, ...extra } };
}

async function runDiffScenarios(port) {
  const out = {};
  for (const [name, steps, opts = {}] of DIFF_SCENARIOS) {
    for (const variant of opts.normalOnly ? ['paid', 'trial'] : ['paid', 'trial', 'mf']) {
      const email = `diff-${variant}-${name}@example.com`;
      if (!opts.noSeed) {
        const seed = { paid: ['active', 0], trial: ['trialing', 0], mf: ['free', 1] }[variant];
        db.prepare('INSERT INTO users (email, status, access_granted, manual_free, trial_end, password_hash) VALUES (?, ?, 1, ?, ?, ?)')
          .run(email, seed[0], seed[1], FUTURE, 'hash-fixed');
      }
      const from = captured.length;
      for (const step of steps) {
        const res = await postWebhook(port, diffEvent(step, email));
        assert.strictEqual(res.status, 200, `${name}: webhook 200`);
      }
      const row = fullRow(email) || {};
      const result = Object.fromEntries(BASE_COLUMNS.map((c) => [c, row[c] === undefined ? null : row[c]]));
      result.mail = mailTo(captured.slice(from), email).length;
      out[`${variant}:${name}`] = result;
    }
  }
  return out;
}

// Recorded by running runDiffScenarios against base 91cfaa56 (TWIC_DIFF_DUMP=<file>).
const BASE_GOLDEN = {
  'paid:stale-deact': {'status': 'canceled', 'trial_end': '2030-01-01T00:00:00.000Z', 'access_granted': 0, 'manual_free': 0, 'whop_membership_id': 'mem_1', 'whop_member_id': null, 'stripe_customer_id': null, 'stripe_subscription_id': null, 'group_name': null, 'password_hash': 'hash-fixed', 'mail': 1},
  'trial:stale-deact': {'status': 'canceled', 'trial_end': '2030-01-01T00:00:00.000Z', 'access_granted': 0, 'manual_free': 0, 'whop_membership_id': 'mem_1', 'whop_member_id': null, 'stripe_customer_id': null, 'stripe_subscription_id': null, 'group_name': null, 'password_hash': 'hash-fixed', 'mail': 1},
  'mf:stale-deact': {'status': 'free', 'trial_end': '2030-01-01T00:00:00.000Z', 'access_granted': 1, 'manual_free': 1, 'whop_membership_id': 'mem_1', 'whop_member_id': null, 'stripe_customer_id': null, 'stripe_subscription_id': null, 'group_name': null, 'password_hash': 'hash-fixed', 'mail': 0},
  'paid:emailonly-after-deact': {'status': 'active', 'trial_end': '2030-01-01T00:00:00.000Z', 'access_granted': 1, 'manual_free': 0, 'whop_membership_id': 'mem_1', 'whop_member_id': null, 'stripe_customer_id': null, 'stripe_subscription_id': null, 'group_name': null, 'password_hash': 'hash-fixed', 'mail': 1},
  'trial:emailonly-after-deact': {'status': 'active', 'trial_end': '2030-01-01T00:00:00.000Z', 'access_granted': 1, 'manual_free': 0, 'whop_membership_id': 'mem_1', 'whop_member_id': null, 'stripe_customer_id': null, 'stripe_subscription_id': null, 'group_name': null, 'password_hash': 'hash-fixed', 'mail': 1},
  'paid:other-membership-deact': {'status': 'canceled', 'trial_end': '2030-01-01T00:00:00.000Z', 'access_granted': 0, 'manual_free': 0, 'whop_membership_id': 'mem_old', 'whop_member_id': null, 'stripe_customer_id': null, 'stripe_subscription_id': null, 'group_name': null, 'password_hash': 'hash-fixed', 'mail': 1},
  'trial:other-membership-deact': {'status': 'canceled', 'trial_end': '2030-01-01T00:00:00.000Z', 'access_granted': 0, 'manual_free': 0, 'whop_membership_id': 'mem_old', 'whop_member_id': null, 'stripe_customer_id': null, 'stripe_subscription_id': null, 'group_name': null, 'password_hash': 'hash-fixed', 'mail': 1},
  'mf:other-membership-deact': {'status': 'free', 'trial_end': '2030-01-01T00:00:00.000Z', 'access_granted': 1, 'manual_free': 1, 'whop_membership_id': 'mem_new', 'whop_member_id': null, 'stripe_customer_id': null, 'stripe_subscription_id': null, 'group_name': null, 'password_hash': 'hash-fixed', 'mail': 0},
  'paid:past-due-other-id': {'status': 'canceled', 'trial_end': '2030-01-01T00:00:00.000Z', 'access_granted': 0, 'manual_free': 0, 'whop_membership_id': 'mem_2', 'whop_member_id': null, 'stripe_customer_id': null, 'stripe_subscription_id': null, 'group_name': null, 'password_hash': 'hash-fixed', 'mail': 1},
  'trial:past-due-other-id': {'status': 'canceled', 'trial_end': '2030-01-01T00:00:00.000Z', 'access_granted': 0, 'manual_free': 0, 'whop_membership_id': 'mem_2', 'whop_member_id': null, 'stripe_customer_id': null, 'stripe_subscription_id': null, 'group_name': null, 'password_hash': 'hash-fixed', 'mail': 1},
  'mf:past-due-other-id': {'status': 'free', 'trial_end': '2030-01-01T00:00:00.000Z', 'access_granted': 1, 'manual_free': 1, 'whop_membership_id': 'mem_1', 'whop_member_id': null, 'stripe_customer_id': null, 'stripe_subscription_id': null, 'group_name': null, 'password_hash': 'hash-fixed', 'mail': 0},
  'paid:flat-pay-then-cancel': {'status': 'canceled', 'trial_end': '2030-01-01T00:00:00.000Z', 'access_granted': 0, 'manual_free': 0, 'whop_membership_id': 'mem_1', 'whop_member_id': null, 'stripe_customer_id': null, 'stripe_subscription_id': null, 'group_name': null, 'password_hash': 'hash-fixed', 'mail': 2},
  'trial:flat-pay-then-cancel': {'status': 'canceled', 'trial_end': '2030-01-01T00:00:00.000Z', 'access_granted': 0, 'manual_free': 0, 'whop_membership_id': 'mem_1', 'whop_member_id': null, 'stripe_customer_id': null, 'stripe_subscription_id': null, 'group_name': null, 'password_hash': 'hash-fixed', 'mail': 2},
  'mf:flat-pay-then-cancel': {'status': 'free', 'trial_end': '2030-01-01T00:00:00.000Z', 'access_granted': 1, 'manual_free': 1, 'whop_membership_id': 'pay_diff', 'whop_member_id': null, 'stripe_customer_id': null, 'stripe_subscription_id': null, 'group_name': null, 'password_hash': 'hash-fixed', 'mail': 0},
  'paid:untimed-then-older-deact': {'status': 'canceled', 'trial_end': '2030-01-01T00:00:00.000Z', 'access_granted': 0, 'manual_free': 0, 'whop_membership_id': 'mem_1', 'whop_member_id': null, 'stripe_customer_id': null, 'stripe_subscription_id': null, 'group_name': null, 'password_hash': 'hash-fixed', 'mail': 1},
  'trial:untimed-then-older-deact': {'status': 'canceled', 'trial_end': '2030-01-01T00:00:00.000Z', 'access_granted': 0, 'manual_free': 0, 'whop_membership_id': 'mem_1', 'whop_member_id': null, 'stripe_customer_id': null, 'stripe_subscription_id': null, 'group_name': null, 'password_hash': 'hash-fixed', 'mail': 1},
  'mf:untimed-then-older-deact': {'status': 'free', 'trial_end': '2030-01-01T00:00:00.000Z', 'access_granted': 1, 'manual_free': 1, 'whop_membership_id': 'mem_1', 'whop_member_id': null, 'stripe_customer_id': null, 'stripe_subscription_id': null, 'group_name': null, 'password_hash': 'hash-fixed', 'mail': 0},
  'paid:far-future-then-deact': {'status': 'canceled', 'trial_end': '2030-01-01T00:00:00.000Z', 'access_granted': 0, 'manual_free': 0, 'whop_membership_id': 'mem_1', 'whop_member_id': null, 'stripe_customer_id': null, 'stripe_subscription_id': null, 'group_name': null, 'password_hash': 'hash-fixed', 'mail': 1},
  'trial:far-future-then-deact': {'status': 'canceled', 'trial_end': '2030-01-01T00:00:00.000Z', 'access_granted': 0, 'manual_free': 0, 'whop_membership_id': 'mem_1', 'whop_member_id': null, 'stripe_customer_id': null, 'stripe_subscription_id': null, 'group_name': null, 'password_hash': 'hash-fixed', 'mail': 1},
  'mf:far-future-then-deact': {'status': 'free', 'trial_end': '2030-01-01T00:00:00.000Z', 'access_granted': 1, 'manual_free': 1, 'whop_membership_id': 'mem_1', 'whop_member_id': null, 'stripe_customer_id': null, 'stripe_subscription_id': null, 'group_name': null, 'password_hash': 'hash-fixed', 'mail': 0},
  'paid:epoch-string-then-deact': {'status': 'canceled', 'trial_end': '2030-01-01T00:00:00.000Z', 'access_granted': 0, 'manual_free': 0, 'whop_membership_id': 'mem_1', 'whop_member_id': null, 'stripe_customer_id': null, 'stripe_subscription_id': null, 'group_name': null, 'password_hash': 'hash-fixed', 'mail': 1},
  'trial:epoch-string-then-deact': {'status': 'canceled', 'trial_end': '2030-01-01T00:00:00.000Z', 'access_granted': 0, 'manual_free': 0, 'whop_membership_id': 'mem_1', 'whop_member_id': null, 'stripe_customer_id': null, 'stripe_subscription_id': null, 'group_name': null, 'password_hash': 'hash-fixed', 'mail': 1},
  'mf:epoch-string-then-deact': {'status': 'free', 'trial_end': '2030-01-01T00:00:00.000Z', 'access_granted': 1, 'manual_free': 1, 'whop_membership_id': 'mem_1', 'whop_member_id': null, 'stripe_customer_id': null, 'stripe_subscription_id': null, 'group_name': null, 'password_hash': 'hash-fixed', 'mail': 0},
  'paid:drafted-other-then-deact': {'status': 'canceled', 'trial_end': '2030-01-01T00:00:00.000Z', 'access_granted': 0, 'manual_free': 0, 'whop_membership_id': 'mem_a', 'whop_member_id': null, 'stripe_customer_id': null, 'stripe_subscription_id': null, 'group_name': null, 'password_hash': 'hash-fixed', 'mail': 2},
  'trial:drafted-other-then-deact': {'status': 'canceled', 'trial_end': '2030-01-01T00:00:00.000Z', 'access_granted': 0, 'manual_free': 0, 'whop_membership_id': 'mem_a', 'whop_member_id': null, 'stripe_customer_id': null, 'stripe_subscription_id': null, 'group_name': null, 'password_hash': 'hash-fixed', 'mail': 2},
  'mf:drafted-other-then-deact': {'status': 'free', 'trial_end': '2030-01-01T00:00:00.000Z', 'access_granted': 1, 'manual_free': 1, 'whop_membership_id': 'mem_b', 'whop_member_id': null, 'stripe_customer_id': null, 'stripe_subscription_id': null, 'group_name': null, 'password_hash': 'hash-fixed', 'mail': 0},
  'paid:metadata-email-then-deact': {'status': 'canceled', 'trial_end': '2030-01-01T00:00:00.000Z', 'access_granted': 0, 'manual_free': 0, 'whop_membership_id': 'mem_v', 'whop_member_id': null, 'stripe_customer_id': null, 'stripe_subscription_id': null, 'group_name': null, 'password_hash': 'hash-fixed', 'mail': 2},
  'trial:metadata-email-then-deact': {'status': 'canceled', 'trial_end': '2030-01-01T00:00:00.000Z', 'access_granted': 0, 'manual_free': 0, 'whop_membership_id': 'mem_v', 'whop_member_id': null, 'stripe_customer_id': null, 'stripe_subscription_id': null, 'group_name': null, 'password_hash': 'hash-fixed', 'mail': 2},
  'mf:metadata-email-then-deact': {'status': 'free', 'trial_end': '2030-01-01T00:00:00.000Z', 'access_granted': 1, 'manual_free': 1, 'whop_membership_id': 'mem_x', 'whop_member_id': null, 'stripe_customer_id': null, 'stripe_subscription_id': null, 'group_name': null, 'password_hash': 'hash-fixed', 'mail': 0},
  'paid:garbage-time-then-deact': {'status': 'canceled', 'trial_end': '2030-01-01T00:00:00.000Z', 'access_granted': 0, 'manual_free': 0, 'whop_membership_id': 'mem_1', 'whop_member_id': null, 'stripe_customer_id': null, 'stripe_subscription_id': null, 'group_name': null, 'password_hash': 'hash-fixed', 'mail': 1},
  'trial:garbage-time-then-deact': {'status': 'canceled', 'trial_end': '2030-01-01T00:00:00.000Z', 'access_granted': 0, 'manual_free': 0, 'whop_membership_id': 'mem_1', 'whop_member_id': null, 'stripe_customer_id': null, 'stripe_subscription_id': null, 'group_name': null, 'password_hash': 'hash-fixed', 'mail': 1},
  'mf:garbage-time-then-deact': {'status': 'free', 'trial_end': '2030-01-01T00:00:00.000Z', 'access_granted': 1, 'manual_free': 1, 'whop_membership_id': 'mem_1', 'whop_member_id': null, 'stripe_customer_id': null, 'stripe_subscription_id': null, 'group_name': null, 'password_hash': 'hash-fixed', 'mail': 0},
  'paid:equal-time': {'status': 'canceled', 'trial_end': '2030-01-01T00:00:00.000Z', 'access_granted': 0, 'manual_free': 0, 'whop_membership_id': 'mem_1', 'whop_member_id': null, 'stripe_customer_id': null, 'stripe_subscription_id': null, 'group_name': null, 'password_hash': 'hash-fixed', 'mail': 1},
  'trial:equal-time': {'status': 'canceled', 'trial_end': '2030-01-01T00:00:00.000Z', 'access_granted': 0, 'manual_free': 0, 'whop_membership_id': 'mem_1', 'whop_member_id': null, 'stripe_customer_id': null, 'stripe_subscription_id': null, 'group_name': null, 'password_hash': 'hash-fixed', 'mail': 1},
  'mf:equal-time': {'status': 'free', 'trial_end': '2030-01-01T00:00:00.000Z', 'access_granted': 1, 'manual_free': 1, 'whop_membership_id': 'mem_1', 'whop_member_id': null, 'stripe_customer_id': null, 'stripe_subscription_id': null, 'group_name': null, 'password_hash': 'hash-fixed', 'mail': 0},
  'paid:replayed-activation': {'status': 'active', 'trial_end': '2030-01-01T00:00:00.000Z', 'access_granted': 1, 'manual_free': 0, 'whop_membership_id': 'mem_1', 'whop_member_id': null, 'stripe_customer_id': null, 'stripe_subscription_id': null, 'group_name': null, 'password_hash': 'hash-fixed', 'mail': 2},
  'trial:replayed-activation': {'status': 'active', 'trial_end': '2030-01-01T00:00:00.000Z', 'access_granted': 1, 'manual_free': 0, 'whop_membership_id': 'mem_1', 'whop_member_id': null, 'stripe_customer_id': null, 'stripe_subscription_id': null, 'group_name': null, 'password_hash': 'hash-fixed', 'mail': 2},
  'mf:replayed-activation': {'status': 'free', 'trial_end': '2030-01-01T00:00:00.000Z', 'access_granted': 1, 'manual_free': 1, 'whop_membership_id': 'mem_1', 'whop_member_id': null, 'stripe_customer_id': null, 'stripe_subscription_id': null, 'group_name': null, 'password_hash': 'hash-fixed', 'mail': 0},
  'paid:switch-then-old-cancel': {'status': 'canceled', 'trial_end': '2030-01-01T00:00:00.000Z', 'access_granted': 0, 'manual_free': 0, 'whop_membership_id': 'mem_a', 'whop_member_id': null, 'stripe_customer_id': null, 'stripe_subscription_id': null, 'group_name': null, 'password_hash': 'hash-fixed', 'mail': 2},
  'trial:switch-then-old-cancel': {'status': 'canceled', 'trial_end': '2030-01-01T00:00:00.000Z', 'access_granted': 0, 'manual_free': 0, 'whop_membership_id': 'mem_a', 'whop_member_id': null, 'stripe_customer_id': null, 'stripe_subscription_id': null, 'group_name': null, 'password_hash': 'hash-fixed', 'mail': 2},
  'mf:switch-then-old-cancel': {'status': 'free', 'trial_end': '2030-01-01T00:00:00.000Z', 'access_granted': 1, 'manual_free': 1, 'whop_membership_id': 'mem_b', 'whop_member_id': null, 'stripe_customer_id': null, 'stripe_subscription_id': null, 'group_name': null, 'password_hash': 'hash-fixed', 'mail': 0},
  'paid:failed-retry-after-success': {'status': 'past_due', 'trial_end': '2030-01-01T00:00:00.000Z', 'access_granted': 1, 'manual_free': 0, 'whop_membership_id': 'mem_1', 'whop_member_id': null, 'stripe_customer_id': null, 'stripe_subscription_id': null, 'group_name': null, 'password_hash': 'hash-fixed', 'mail': 3},
  'trial:failed-retry-after-success': {'status': 'past_due', 'trial_end': '2030-01-01T00:00:00.000Z', 'access_granted': 1, 'manual_free': 0, 'whop_membership_id': 'mem_1', 'whop_member_id': null, 'stripe_customer_id': null, 'stripe_subscription_id': null, 'group_name': null, 'password_hash': 'hash-fixed', 'mail': 3},
  'mf:failed-retry-after-success': {'status': 'free', 'trial_end': '2030-01-01T00:00:00.000Z', 'access_granted': 1, 'manual_free': 1, 'whop_membership_id': 'mem_1', 'whop_member_id': null, 'stripe_customer_id': null, 'stripe_subscription_id': null, 'group_name': null, 'password_hash': 'hash-fixed', 'mail': 0},
  'paid:trial-notice-late': {'status': 'active', 'trial_end': '2026-10-01T01:00:00.000Z', 'access_granted': 1, 'manual_free': 0, 'whop_membership_id': 'mem_1', 'whop_member_id': null, 'stripe_customer_id': null, 'stripe_subscription_id': null, 'group_name': null, 'password_hash': 'hash-fixed', 'mail': 3},
  'trial:trial-notice-late': {'status': 'active', 'trial_end': '2026-10-01T01:00:00.000Z', 'access_granted': 1, 'manual_free': 0, 'whop_membership_id': 'mem_1', 'whop_member_id': null, 'stripe_customer_id': null, 'stripe_subscription_id': null, 'group_name': null, 'password_hash': 'hash-fixed', 'mail': 3},
  'mf:trial-notice-late': {'status': 'free', 'trial_end': '2030-01-01T00:00:00.000Z', 'access_granted': 1, 'manual_free': 1, 'whop_membership_id': 'mem_1', 'whop_member_id': null, 'stripe_customer_id': null, 'stripe_subscription_id': null, 'group_name': null, 'password_hash': 'hash-fixed', 'mail': 0},
  'paid:past-due-then-deact': {'status': 'canceled', 'trial_end': '2030-01-01T00:00:00.000Z', 'access_granted': 0, 'manual_free': 0, 'whop_membership_id': 'mem_1', 'whop_member_id': null, 'stripe_customer_id': null, 'stripe_subscription_id': null, 'group_name': null, 'password_hash': 'hash-fixed', 'mail': 2},
  'trial:past-due-then-deact': {'status': 'canceled', 'trial_end': '2030-01-01T00:00:00.000Z', 'access_granted': 0, 'manual_free': 0, 'whop_membership_id': 'mem_1', 'whop_member_id': null, 'stripe_customer_id': null, 'stripe_subscription_id': null, 'group_name': null, 'password_hash': 'hash-fixed', 'mail': 2},
  'mf:past-due-then-deact': {'status': 'free', 'trial_end': '2030-01-01T00:00:00.000Z', 'access_granted': 1, 'manual_free': 1, 'whop_membership_id': 'mem_1', 'whop_member_id': null, 'stripe_customer_id': null, 'stripe_subscription_id': null, 'group_name': null, 'password_hash': 'hash-fixed', 'mail': 0},
  'paid:trialing-then-active': {'status': 'active', 'trial_end': '2030-01-01T00:00:00.000Z', 'access_granted': 1, 'manual_free': 0, 'whop_membership_id': 'mem_1', 'whop_member_id': null, 'stripe_customer_id': null, 'stripe_subscription_id': null, 'group_name': null, 'password_hash': 'hash-fixed', 'mail': 2},
  'trial:trialing-then-active': {'status': 'active', 'trial_end': '2030-01-01T00:00:00.000Z', 'access_granted': 1, 'manual_free': 0, 'whop_membership_id': 'mem_1', 'whop_member_id': null, 'stripe_customer_id': null, 'stripe_subscription_id': null, 'group_name': null, 'password_hash': 'hash-fixed', 'mail': 2},
  'mf:trialing-then-active': {'status': 'free', 'trial_end': '2030-01-01T00:00:00.000Z', 'access_granted': 1, 'manual_free': 1, 'whop_membership_id': 'mem_1', 'whop_member_id': null, 'stripe_customer_id': null, 'stripe_subscription_id': null, 'group_name': null, 'password_hash': 'hash-fixed', 'mail': 0},
  'paid:new-user': {'status': 'trialing', 'trial_end': '2030-01-01T00:00:00.000Z', 'access_granted': 1, 'manual_free': 0, 'whop_membership_id': 'mem_n', 'whop_member_id': null, 'stripe_customer_id': null, 'stripe_subscription_id': null, 'group_name': null, 'password_hash': null, 'mail': 1},
  'trial:new-user': {'status': 'trialing', 'trial_end': '2030-01-01T00:00:00.000Z', 'access_granted': 1, 'manual_free': 0, 'whop_membership_id': 'mem_n', 'whop_member_id': null, 'stripe_customer_id': null, 'stripe_subscription_id': null, 'group_name': null, 'password_hash': null, 'mail': 1},
  'mf:new-user': {'status': 'trialing', 'trial_end': '2030-01-01T00:00:00.000Z', 'access_granted': 1, 'manual_free': 0, 'whop_membership_id': 'mem_n', 'whop_member_id': null, 'stripe_customer_id': null, 'stripe_subscription_id': null, 'group_name': null, 'password_hash': null, 'mail': 1},
};

async function normalUsersMatchBase(port) {
  const got = await runDiffScenarios(port);
  assert.deepStrictEqual(Object.keys(got).sort(), Object.keys(BASE_GOLDEN).sort(), 'same scenario set as base');
  for (const key of Object.keys(BASE_GOLDEN)) {
    assert.deepStrictEqual(got[key], BASE_GOLDEN[key], `${key}: normal columns and mail match base 91cfaa56`);
  }
}

async function main() {
  const { server, port } = await listen();
  if (process.env.TWIC_DIFF_DUMP) {
    // Differential mode: record normal column results for this server build, then stop.
    try {
      fs.writeFileSync(process.env.TWIC_DIFF_DUMP, JSON.stringify(await runDiffScenarios(port), null, 2));
    } finally {
      console.log = origLog;
      await new Promise((resolve) => server.close(resolve));
      try { db.close(); } catch (e) {}
      cleanDb();
    }
    return;
  }
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
    await liveTrialKeepsAccess(port);
    await legacyNullWithMembershipRefused(port);
    await eventsAreOrdered(port);
    await emailOnlyPlanCheck(port);
    await magicLinkMatchesAccess(port);
    await shadowRules(port);
    await normalUsersMatchBase(port);
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
