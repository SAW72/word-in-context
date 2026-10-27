'use strict';
/**
 * An admin access revoke (POST /api/admin/set-access with access_granted false) takes
 * precedence over any Whop grant that is not strictly newer than it, and a Whop grant
 * older than the last applied Whop event for the row is refused. A refused grant writes
 * nothing and sends no email. A newer real Whop event (a new payment or a new trial)
 * still restores access and clears the revoke marker. A late live event for another
 * membership than the row's stored one is not stale; it still has to beat a revoke.
 * Free forever, paying users,
 * Whop past_due and 14 day testers keep their existing behavior.
 * Each case runs on its own rows; the run reports every case, then fails if any did.
 */
const assert = require('assert');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const jwt = require('jsonwebtoken');
const { Webhook } = require('standardwebhooks');

const dbFile = path.join(os.tmpdir(), `wic-adminrevoke-${process.pid}.db`);
function cleanDb() {
  for (const extra of [dbFile, dbFile + '-wal', dbFile + '-shm']) {
    try { fs.unlinkSync(extra); } catch (e) {}
  }
}
cleanDb();

const WEBHOOK_SECRET = 'whsec_' + Buffer.from('a1b2c3d4e5f6a7b8c9d0a1b2c3d4e5f6').toString('base64');
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
const security = require('./security');
const wh = new Webhook(WEBHOOK_SECRET);

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
// The signed header is always the real send time (now). The envelope timestamp defaults to
// now too; an event sets its own (or undefined for none) to model a delayed or replayed event.
async function postWebhook(port, event) {
  const id = 'msg_adminrevoke_' + (++msgN);
  const now = new Date();
  const body = !('timestamp' in event) ? { ...event, timestamp: now.toISOString() } : event;
  const payload = JSON.stringify(body);
  const res = await request(port, {
    method: 'POST',
    path: '/api/whop-webhook',
    headers: {
      'Content-Type': 'application/json',
      'webhook-id': id,
      'webhook-timestamp': String(Math.floor(now.getTime() / 1000)),
      'webhook-signature': wh.sign(id, now, payload),
    },
    body: payload,
  });
  assert.strictEqual(res.status, 200, `webhook ${event.type} 200`);
  return res;
}

function adminToken() {
  return jwt.sign({ role: 'admin' }, process.env.JWT_SECRET, { expiresIn: '1h' });
}

async function setAccess(port, email, body) {
  const res = await request(port, {
    method: 'POST',
    path: '/api/admin/set-access',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + adminToken() },
    body: JSON.stringify({ email, ...body }),
  });
  assert.strictEqual(res.status, 200, `set-access ${email} 200`);
}

async function createTester(port, email) {
  const res = await request(port, {
    method: 'POST',
    path: '/api/admin/create-special-tester',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + adminToken() },
    body: JSON.stringify({ email }),
  });
  assert.strictEqual(res.status, 200, `create tester ${email} 200`);
}

function row(email) {
  return db.prepare('SELECT * FROM users WHERE email = ?').get(email);
}

function mailTo(from, email) {
  return captured.slice(from).filter((l) => l.includes(`[WHOP EMAIL to ${email}]`) || l.includes(`[MAGIC LINK for ${email}]`));
}

async function meStatus(port, email) {
  const token = jwt.sign({ email }, process.env.JWT_SECRET, { expiresIn: '1h' });
  return (await request(port, { method: 'GET', path: '/api/me', headers: { Authorization: 'Bearer ' + token } })).status;
}

const MIN = 60 * 1000;
const at = (offsetMs) => new Date(Date.now() + offsetMs).toISOString();

function seed(email, { status = 'active', access = 1, manualFree = 0, membership = null, trialEnd = '2030-01-01T00:00:00.000Z' } = {}) {
  db.prepare('INSERT INTO users (email, status, access_granted, manual_free, trial_end, whop_membership_id, password_hash) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(email, status, access, manualFree, trialEnd, membership, 'hash-fixed');
}

function membershipEvent(type, email, id, status, time, extra = {}) {
  return { type, timestamp: time, data: { id, status, plan: { id: PLAN }, user: { email }, updated_at: time, ...extra } };
}

function paymentEvent(email, membershipId, time, { envelope = time, billing = 'subscription_cycle' } = {}) {
  return {
    type: 'payment.succeeded',
    timestamp: envelope,
    data: {
      id: 'pay_' + (++msgN), billing_reason: billing, created_at: time, paid_at: time, updated_at: time,
      membership: { id: membershipId, status: 'active', plan: { id: PLAN }, user: { email } },
    },
  };
}

function emailOnlyPayment(email, time, { envelope = time } = {}) {
  return { type: 'payment.succeeded', timestamp: envelope, data: { email, plan: { id: PLAN }, created_at: time, paid_at: time, updated_at: time } };
}

function assertRevoked(email, label, from, before) {
  const r = row(email);
  assert.strictEqual(r.access_granted, 0, `${label}: access stays off`);
  assert.strictEqual(r.status, before.status, `${label}: status unchanged`);
  assert.ok(r.access_revoked_at, `${label}: revoke marker kept`);
  assert.deepStrictEqual(mailTo(from, email), [], `${label}: no email`);
}

const cases = [];
function test(name, fn) { cases.push([name, fn]); }

// 1. A stale payment.succeeded after an admin revoke: access stays off, no email.
test('1 stale payment.succeeded after admin revoke', async (port) => {
  const variants = [
    ['own membership, older paid_at', (e) => paymentEvent(e, 'mem_c1', at(-30 * MIN))],
    ['own membership, replayed with a fresh envelope', (e) => paymentEvent(e, 'mem_c1', at(-30 * MIN), { envelope: at(0) })],
    ['email only, older', (e) => emailOnlyPayment(e, at(-30 * MIN))],
    ['email only, replayed with a fresh envelope', (e) => emailOnlyPayment(e, at(-30 * MIN), { envelope: at(0) })],
    ['no usable time', (e) => ({ type: 'payment.succeeded', timestamp: undefined, data: { id: 'pay_nt', membership: { id: 'mem_c1', status: 'active', plan: { id: PLAN }, user: { email: e } } } })],
    ['email only, no usable time', (e) => ({ type: 'payment.succeeded', timestamp: undefined, data: { email: e, plan: { id: PLAN } } })],
  ];
  let i = 0;
  for (const [label, make] of variants) {
    const email = `c1-${++i}@example.com`;
    seed(email, { membership: 'mem_c1' });
    await setAccess(port, email, { access_granted: false, manual_free: false });
    const before = row(email);
    const from = captured.length;
    await postWebhook(port, make(email));
    assertRevoked(email, `1 ${label}`, from, before);
    assert.strictEqual(await meStatus(port, email), 403, `1 ${label}: /api/me still denied`);
  }
});

// 2. Out of order membership events.
test('2 out of order membership events', async (port) => {
  // (a) An older activation arriving after an admin revoke.
  for (const type of ['membership.went_valid', 'membership.activated', 'membership.created']) {
    const email = `c2a-${type.split('.')[1]}@example.com`;
    seed(email, { membership: 'mem_c2' });
    await setAccess(port, email, { access_granted: false, manual_free: false });
    const before = row(email);
    const from = captured.length;
    await postWebhook(port, membershipEvent(type, email, 'mem_c2', 'active', at(-20 * MIN)));
    assertRevoked(email, `2a ${type}`, from, before);
  }
  // (a2) Free forever row revoked by the admin, then an older Whop grant.
  {
    const email = 'c2a-free-forever@example.com';
    seed(email, { status: 'free', manualFree: 1 });
    await setAccess(port, email, { access_granted: false, manual_free: true });
    const before = row(email);
    const from = captured.length;
    await postWebhook(port, membershipEvent('membership.activated', email, 'mem_c2f', 'active', at(-20 * MIN)));
    assertRevoked(email, '2a2 free forever', from, before);
  }
  // (b) No revoke: an older activation after a newer deactivation does not re grant.
  {
    const email = 'c2b@example.com';
    seed(email, { membership: 'mem_c2b' });
    await postWebhook(port, membershipEvent('membership.deactivated', email, 'mem_c2b', 'active', at(-10 * MIN)));
    assert.strictEqual(row(email).access_granted, 0, '2b deactivation applies');
    const from = captured.length;
    await postWebhook(port, membershipEvent('membership.went_valid', email, 'mem_c2b', 'active', at(-20 * MIN)));
    const r = row(email);
    assert.strictEqual(r.access_granted, 0, '2b older activation does not re grant');
    assert.strictEqual(r.status, 'canceled', '2b status stays canceled');
    assert.deepStrictEqual(mailTo(from, email), [], '2b no email');
  }
  // (c) Revoke, a newer event restores, then an older (but post revoke) event: no second grant or email.
  {
    const email = 'c2c@example.com';
    seed(email, { membership: 'mem_c2c' });
    await setAccess(port, email, { access_granted: false, manual_free: false });
    await postWebhook(port, paymentEvent(email, 'mem_c2c', at(2 * MIN)));
    assert.strictEqual(row(email).access_granted, 1, '2c newer payment restores');
    await postWebhook(port, membershipEvent('membership.deactivated', email, 'mem_c2c', 'active', at(3 * MIN)));
    assert.strictEqual(row(email).access_granted, 0, '2c newer deactivation applies');
    const from = captured.length;
    await postWebhook(port, membershipEvent('membership.activated', email, 'mem_c2c', 'active', at(1 * MIN)));
    assert.strictEqual(row(email).access_granted, 0, '2c older activation after the newest event does not re grant');
    assert.deepStrictEqual(mailTo(from, email), [], '2c no email');
  }
  // (d) An activation with no usable time after a revoke.
  {
    const email = 'c2d@example.com';
    seed(email, { membership: 'mem_c2d' });
    await setAccess(port, email, { access_granted: false, manual_free: false });
    const before = row(email);
    const from = captured.length;
    await postWebhook(port, { type: 'membership.activated', timestamp: undefined, data: { id: 'mem_c2d', status: 'active', plan: { id: PLAN }, user: { email } } });
    assertRevoked(email, '2d no time', from, before);
  }
});

// 3. A genuinely new payment after a revoke restores access and clears the marker.
test('3 new payment after revoke restores access', async (port) => {
  const variants = [
    ['own membership', (e) => paymentEvent(e, 'mem_c3', at(1 * MIN))],
    ['new membership', (e) => paymentEvent(e, 'mem_c3_new', at(1 * MIN))],
    ['email only', (e) => emailOnlyPayment(e, at(1 * MIN))],
  ];
  let i = 0;
  for (const [label, make] of variants) {
    const email = `c3-${++i}@example.com`;
    seed(email, { membership: 'mem_c3' });
    await setAccess(port, email, { access_granted: false, manual_free: false });
    assert.ok(row(email).access_revoked_at, `3 ${label}: revoke recorded`);
    await postWebhook(port, make(email));
    const r = row(email);
    assert.strictEqual(r.access_granted, 1, `3 ${label}: access restored`);
    assert.strictEqual(r.status, 'active', `3 ${label}: status active`);
    assert.strictEqual(r.access_revoked_at, null, `3 ${label}: marker cleared`);
    assert.strictEqual(await meStatus(port, email), 200, `3 ${label}: /api/me allowed`);
  }
  // Admin turning access back on clears the marker too.
  const email = 'c3-admin-on@example.com';
  seed(email, { membership: 'mem_c3a' });
  await setAccess(port, email, { access_granted: false, manual_free: false });
  await setAccess(port, email, { access_granted: true, manual_free: false });
  assert.strictEqual(row(email).access_revoked_at, null, '3 admin access on clears the marker');
});

// 4. Free forever and paying users unchanged.
test('4 free forever and paying users unchanged', async (port) => {
  // Free forever with access on: Whop grants keep it free, with access, and send no email.
  {
    const email = 'c4-ff@example.com';
    seed(email, { status: 'free', manualFree: 1 });
    const from = captured.length;
    await postWebhook(port, membershipEvent('membership.activated', email, 'mem_c4ff', 'active', at(0)));
    await postWebhook(port, paymentEvent(email, 'mem_c4ff', at(0)));
    const r = row(email);
    assert.strictEqual(r.access_granted, 1, '4 free forever keeps access');
    assert.strictEqual(r.status, 'free', '4 free forever keeps status');
    assert.deepStrictEqual(mailTo(from, email), [], '4 free forever gets no email');
  }
  // Paying user, never revoked: an activation then a renewal keep access, status active.
  {
    const email = 'c4-paid@example.com';
    seed(email, { status: 'pending', access: 0 });
    await postWebhook(port, membershipEvent('membership.activated', email, 'mem_c4p', 'active', at(-5 * MIN)));
    await postWebhook(port, paymentEvent(email, 'mem_c4p', at(0)));
    const r = row(email);
    assert.strictEqual(r.access_granted, 1, '4 paying user has access');
    assert.strictEqual(r.status, 'active', '4 paying user active');
    assert.strictEqual(r.access_revoked_at, null, '4 paying user has no marker');
  }
  // Paying through Whop, then the admin turns free forever off: keeps access, renewals still work.
  {
    const email = 'c4-paid-ff-off@example.com';
    seed(email, { status: 'free', manualFree: 1 });
    await postWebhook(port, membershipEvent('membership.activated', email, 'mem_c4o', 'active', at(-5 * MIN)));
    await setAccess(port, email, { access_granted: true, manual_free: false });
    let r = row(email);
    assert.strictEqual(r.status, 'active', '4 free forever off keeps a live Whop payer active');
    assert.strictEqual(r.access_granted, 1, '4 free forever off keeps access');
    await postWebhook(port, paymentEvent(email, 'mem_c4o', at(0)));
    r = row(email);
    assert.strictEqual(r.access_granted, 1, '4 renewal after free forever off keeps access');
    assert.strictEqual(r.status, 'active', '4 renewal after free forever off keeps active');
  }
  // Whop past_due keeps access, and its own newer payment clears it.
  {
    const email = 'c4-pastdue@example.com';
    seed(email, { membership: 'mem_c4d' });
    await postWebhook(port, membershipEvent('membership.activated', email, 'mem_c4d', 'active', at(-10 * MIN)));
    await postWebhook(port, { type: 'payment.failed', timestamp: at(-5 * MIN), data: { id: 'pay_c4f', billing_reason: 'subscription_cycle', membership: { id: 'mem_c4d' }, plan: { id: PLAN }, user: { email }, updated_at: at(-5 * MIN) } });
    assert.strictEqual(row(email).status, 'past_due', '4 renewal failure marks past_due');
    assert.strictEqual(await meStatus(port, email), 200, '4 past_due keeps access');
    await postWebhook(port, paymentEvent(email, 'mem_c4d', at(0)));
    assert.strictEqual(row(email).status, 'active', '4 newer own payment clears past_due');
  }
});

// 5. A 14 day tester cut off by trial_end, or revoked by the admin, can start a new 7 day Whop trial.
test('5 tester can start a new 7 day Whop trial', async (port) => {
  for (const how of ['expired', 'revoked']) {
    const email = `c5-${how}@example.com`;
    await createTester(port, email);
    if (how === 'expired') db.prepare('UPDATE users SET trial_end = ? WHERE email = ?').run(at(-60 * MIN), email);
    else await setAccess(port, email, { access_granted: false, manual_free: false });
    const from = captured.length;
    const trialEnd = at(7 * 24 * 60 * MIN);
    await postWebhook(port, membershipEvent('membership.went_valid', email, `mem_c5_${how}`, 'trialing', at(1 * MIN), { created_at: at(1 * MIN), renewal_period_end: trialEnd }));
    const r = row(email);
    assert.strictEqual(r.access_granted, 1, `5 ${how}: new trial grants access`);
    assert.strictEqual(r.status, 'trialing', `5 ${how}: status trialing`);
    assert.strictEqual(r.trial_end, trialEnd, `5 ${how}: Whop trial end`);
    assert.strictEqual(r.access_revoked_at, null, `5 ${how}: no marker after a new trial`);
    assert.strictEqual(mailTo(from, email).length, 1, `5 ${how}: trial login email sent`);
  }
});

// 6. A stale payment.succeeded that skips the past_due clear does not reach activateWhopMembership.
test('6 stale payment.succeeded writes no older status', async (port) => {
  // (a) past_due from a newer renewal failure, then an older success: stays past_due, no email.
  {
    const email = 'c6-pastdue@example.com';
    seed(email, { membership: 'mem_c6' });
    await postWebhook(port, membershipEvent('membership.activated', email, 'mem_c6', 'active', at(-30 * MIN)));
    await postWebhook(port, { type: 'payment.failed', timestamp: at(-10 * MIN), data: { id: 'pay_c6f', billing_reason: 'subscription_cycle', membership: { id: 'mem_c6' }, plan: { id: PLAN }, user: { email }, updated_at: at(-10 * MIN) } });
    assert.strictEqual(row(email).status, 'past_due', '6a marked past_due');
    const from = captured.length;
    await postWebhook(port, paymentEvent(email, 'mem_c6', at(-20 * MIN)));
    assert.strictEqual(row(email).status, 'past_due', '6a older success does not write active');
    assert.deepStrictEqual(mailTo(from, email), [], '6a no email');
  }
  // (b) canceled by a newer deactivation, then an older success: stays canceled, no email.
  {
    const email = 'c6-canceled@example.com';
    seed(email, { membership: 'mem_c6b' });
    await postWebhook(port, membershipEvent('membership.deactivated', email, 'mem_c6b', 'active', at(-10 * MIN)));
    const from = captured.length;
    await postWebhook(port, paymentEvent(email, 'mem_c6b', at(-20 * MIN)));
    const r = row(email);
    assert.strictEqual(r.status, 'canceled', '6b older success does not write active');
    assert.strictEqual(r.access_granted, 0, '6b older success does not re grant');
    assert.deepStrictEqual(mailTo(from, email), [], '6b no email');
  }
});

// 7. Ownership: an event for another account leaves a revoked row alone.
test('7 event for another account leaves the revoked row alone', async (port) => {
  const a = 'c7-a@example.com';
  const b = 'c7-b@example.com';
  seed(a, { membership: 'mem_c7a' });
  await setAccess(port, a, { access_granted: false, manual_free: false });
  const before = row(a);
  const from = captured.length;
  await postWebhook(port, paymentEvent(b, 'mem_c7b', at(1 * MIN)));
  await postWebhook(port, membershipEvent('membership.activated', b, 'mem_c7a', 'active', at(1 * MIN)));
  await postWebhook(port, emailOnlyPayment(b, at(1 * MIN)));
  assert.deepStrictEqual(row(a), before, '7 revoked row unchanged by another account events');
  assert.deepStrictEqual(mailTo(from, a), [], '7 no email to the revoked account');
  assert.strictEqual(row(b).access_granted, 1, '7 the other account is granted normally');
});

// 8. The pure gate and grant time.
test('8 whopGrantRefusal and whopGrantEventTime', async () => {
  const { whopGrantRefusal, whopGrantEventTime } = security;
  assert.strictEqual(typeof whopGrantRefusal, 'function', '8 whopGrantRefusal exported');
  const R = '2026-10-01T12:00:00.000Z';
  const user = { access_revoked_at: R };
  assert.strictEqual(whopGrantRefusal(null, {}), null);
  assert.strictEqual(whopGrantRefusal({ access_revoked_at: null }, { eventAt: null }), null, 'no marker, no time: allowed');
  assert.strictEqual(whopGrantRefusal({ access_revoked_at: null }, { shadowReason: 'stale' }), 'stale');
  assert.strictEqual(whopGrantRefusal(user, { eventAt: '2026-10-01T12:00:00.001Z' }), null, 'strictly newer: allowed');
  assert.strictEqual(whopGrantRefusal(user, { eventAt: R }), 'admin_revoke', 'equal time: refused');
  assert.strictEqual(whopGrantRefusal(user, { eventAt: '2026-10-01T11:00:00.000Z' }), 'admin_revoke');
  assert.strictEqual(whopGrantRefusal(user, { eventAt: null }), 'admin_revoke', 'no time: refused');
  assert.strictEqual(whopGrantRefusal(user, undefined), 'admin_revoke', 'no grant: refused');
  assert.strictEqual(whopGrantRefusal({ access_revoked_at: 'garbage' }, { eventAt: '2030-01-01T00:00:00.000Z' }), 'admin_revoke', 'unreadable marker fails closed');
  for (const reason of [null, 'no_time', 'other_membership', 'unknown_status']) {
    assert.strictEqual(whopGrantRefusal({ access_revoked_at: null }, { eventAt: R, shadowReason: reason }), null, `shadow ${reason} alone does not refuse`);
  }
  const hdr = String(Math.floor(Date.parse('2026-10-01T12:00:00.000Z') / 1000));
  const T = (m) => new Date(Date.parse('2026-10-01T12:00:00.000Z') + m * MIN).toISOString();
  assert.strictEqual(whopGrantEventTime({ timestamp: T(0) }, { updated_at: T(-1), created_at: T(-9), paid_at: T(-5) }, hdr), T(-9), 'earliest object time');
  assert.strictEqual(whopGrantEventTime({ timestamp: T(-3) }, {}, hdr), T(-3), 'envelope when no object time');
  assert.strictEqual(whopGrantEventTime({ timestamp: T(0) }, { membership: { updated_at: T(-60) } }, hdr), T(0), 'nested membership times not used');
  assert.strictEqual(whopGrantEventTime({ timestamp: T(60) }, {}, hdr), T(5), 'capped at header plus skew');
  assert.strictEqual(whopGrantEventTime({}, {}, hdr), null, 'no time');
  assert.strictEqual(whopGrantEventTime({ timestamp: T(0) }, {}, undefined), null, 'no header, no time');
  const flat = { updated_at: T(-2) };
  assert.strictEqual(whopGrantEventTime(flat, flat, hdr), T(-2), 'unwrapped payload has no envelope');
});

// 9. Membership switch out of order: the newer cancel of the old membership lands before
// the late activation or first payment of the new one. The new membership's grant is not
// refused as stale because of the old membership's newer time, unless an admin revoked.
test('9 membership switch out of order', async (port) => {
  const lateGrants = [
    ['activation', (e) => membershipEvent('membership.activated', e, 'mem_c9_new', 'active', at(-20 * MIN)), 'active'],
    ['first payment', (e) => paymentEvent(e, 'mem_c9_new', at(-20 * MIN), { billing: 'subscription_create' }), 'active'],
    ['trial', (e) => membershipEvent('membership.went_valid', e, 'mem_c9_new', 'trialing', at(-20 * MIN), { renewal_period_end: at(7 * 24 * 60 * MIN) }), 'trialing'],
  ];
  let i = 0;
  for (const [label, make, status] of lateGrants) {
    const email = `c9-${++i}@example.com`;
    seed(email, { status: 'pending', access: 0 });
    await postWebhook(port, membershipEvent('membership.activated', email, 'mem_c9_old', 'active', at(-30 * MIN)));
    const cancelAt = at(-10 * MIN);
    await postWebhook(port, membershipEvent('membership.deactivated', email, 'mem_c9_old', 'canceled', cancelAt));
    assert.strictEqual(row(email).access_granted, 0, `9 ${label}: old membership cancel applies`);
    const from = captured.length;
    await postWebhook(port, make(email));
    const r = row(email);
    assert.strictEqual(r.access_granted, 1, `9 ${label}: late grant of the new membership restores access`);
    assert.strictEqual(r.status, status, `9 ${label}: status ${status}`);
    assert.strictEqual(r.whop_membership_id, 'mem_c9_new', `9 ${label}: row now on the new membership`);
    assert.strictEqual(mailTo(from, email).length, 1, `9 ${label}: one login email`);
    assert.strictEqual(r.whop_status, status, `9 ${label}: shadow switched`);
    assert.strictEqual(r.whop_event_at, cancelAt, `9 ${label}: shadow keeps the newer event time`);
    // The new membership's own older events stay stale against its newer cancel.
    await postWebhook(port, membershipEvent('membership.went_invalid', email, 'mem_c9_new', 'canceled', at(-5 * MIN)));
    const from2 = captured.length;
    await postWebhook(port, paymentEvent(email, 'mem_c9_new', at(-15 * MIN)));
    assert.strictEqual(row(email).access_granted, 0, `9 ${label}: older own payment after the new membership's cancel is stale`);
    assert.deepStrictEqual(mailTo(from2, email), [], `9 ${label}: no email for the stale payment`);
  }
  // An admin revoke still wins over the late new membership grant.
  {
    const email = 'c9-revoked@example.com';
    seed(email, { status: 'pending', access: 0 });
    await postWebhook(port, membershipEvent('membership.activated', email, 'mem_c9r_old', 'active', at(-30 * MIN)));
    await postWebhook(port, membershipEvent('membership.deactivated', email, 'mem_c9r_old', 'canceled', at(-10 * MIN)));
    await setAccess(port, email, { access_granted: false, manual_free: false });
    const before = row(email);
    const from = captured.length;
    await postWebhook(port, membershipEvent('membership.activated', email, 'mem_c9r_new', 'active', at(-20 * MIN)));
    await postWebhook(port, paymentEvent(email, 'mem_c9r_new', at(-20 * MIN), { billing: 'subscription_create' }));
    assertRevoked(email, '9 revoked', from, before);
  }
  // Pure shadow rule: only a live event naming another stored membership escapes stale.
  const { whopShadowUpdate } = security;
  const prev = { whop_status: 'canceled', whop_trial_end: null, whop_event_at: '2026-10-01T12:00:00.000Z', whop_membership_id: 'mem_a' };
  const older = '2026-10-01T11:00:00.000Z';
  const late = whopShadowUpdate(prev, { status: 'active', membershipId: 'mem_b', eventAt: older });
  assert.deepStrictEqual(late, { patch: { whop_status: 'active', whop_trial_end: null, whop_event_at: prev.whop_event_at }, reason: 'late_other_membership' }, '9 live other membership applies, keeps time');
  assert.strictEqual(whopShadowUpdate(prev, { status: 'active', membershipId: 'mem_a', eventAt: older }).reason, 'stale', '9 own membership older is stale');
  assert.strictEqual(whopShadowUpdate(prev, { status: 'canceled', membershipId: 'mem_b', eventAt: older }).reason, 'stale', '9 other membership not live is stale');
  assert.strictEqual(whopShadowUpdate(prev, { status: 'active', membershipId: null, eventAt: older }).reason, 'stale', '9 no membership named is stale');
  assert.strictEqual(whopShadowUpdate({ ...prev, whop_membership_id: 'pay_1' }, { status: 'active', membershipId: 'mem_b', eventAt: older }).reason, 'stale', '9 stored pay_ id is stale');
  assert.strictEqual(whopShadowUpdate({ ...prev, whop_membership_id: null }, { status: 'active', membershipId: 'mem_b', eventAt: older }).reason, 'stale', '9 no stored membership is stale');
  const seenAt = (t) => ({ ...prev, whop_membership_times: JSON.stringify({ mem_b: t }) });
  assert.strictEqual(whopShadowUpdate(seenAt(older), { status: 'active', membershipId: 'mem_b', eventAt: older }).reason, 'stale', '9 replay at the seen time is stale');
  assert.strictEqual(whopShadowUpdate(seenAt('2026-10-01T11:30:00.000Z'), { status: 'active', membershipId: 'mem_b', eventAt: older }).reason, 'stale', '9 older than the seen time is stale');
  assert.strictEqual(whopShadowUpdate(seenAt('2026-10-01T10:00:00.000Z'), { status: 'active', membershipId: 'mem_b', eventAt: older }).reason, 'late_other_membership', '9 newer than the seen time applies');
  assert.strictEqual(whopShadowUpdate({ ...prev, whop_membership_times: 'not json' }, { status: 'active', membershipId: 'mem_b', eventAt: older }).reason, 'stale', '9 unreadable history is stale');
  const { whopMembershipTimes, whopMembershipTimesAfter } = security;
  assert.deepStrictEqual(whopMembershipTimes(null), {}, '9 NULL history is empty');
  assert.strictEqual(whopMembershipTimes('[1]'), null, '9 non object history is unreadable');
  assert.deepStrictEqual(whopMembershipTimes(JSON.stringify({ mem_x: older, pay_1: older, mem_y: 'bad' })), { mem_x: older }, '9 bad entries dropped');
  assert.strictEqual(whopMembershipTimesAfter(JSON.stringify({ mem_x: older }), { membershipId: 'mem_x', eventAt: older }), null, '9 same time: unchanged');
  assert.strictEqual(whopMembershipTimesAfter(null, { membershipId: 'mem_x', eventAt: null }), null, '9 no time: unchanged');
  assert.deepStrictEqual(JSON.parse(whopMembershipTimesAfter(JSON.stringify({ mem_x: older }), { membershipId: 'mem_x', eventAt: prev.whop_event_at })), { mem_x: prev.whop_event_at }, '9 newer time raises');
  let many = null;
  for (let k = 0; k < 25; k++) many = whopMembershipTimesAfter(many, { membershipId: `mem_${k}`, eventAt: new Date(Date.parse(older) + k * MIN).toISOString() });
  const kept = Object.keys(JSON.parse(many));
  assert.strictEqual(kept.length, 20, '9 history bounded');
  assert.ok(kept.includes('mem_24') && !kept.includes('mem_4'), '9 newest kept');
});

// 10. Explicit grants clear the revoke marker.
test('10 tester creation and free forever grants clear the revoke marker', async (port) => {
  // (a) create-special-tester on a revoked row is an explicit admin grant.
  {
    const email = 'c10-tester@example.com';
    seed(email, { membership: 'mem_c10t' });
    await setAccess(port, email, { access_granted: false, manual_free: false });
    assert.ok(row(email).access_revoked_at, '10a revoke recorded');
    await createTester(port, email);
    const r = row(email);
    assert.strictEqual(r.access_granted, 1, '10a tester has access');
    assert.strictEqual(r.access_revoked_at, null, '10a tester creation clears the marker');
  }
  // (b) A revoked free forever row, then a newer Whop grant: access back on, marker cleared, still free.
  {
    const email = 'c10-ff@example.com';
    seed(email, { status: 'free', manualFree: 1 });
    await setAccess(port, email, { access_granted: false, manual_free: true });
    assert.ok(row(email).access_revoked_at, '10b revoke recorded');
    await postWebhook(port, membershipEvent('membership.activated', email, 'mem_c10f', 'active', at(1 * MIN)));
    const r = row(email);
    assert.strictEqual(r.access_granted, 1, '10b newer grant restores access');
    assert.strictEqual(r.status, 'free', '10b still free forever');
    assert.strictEqual(r.access_revoked_at, null, '10b free forever grant clears the marker');
  }
});

// 11. A replay of an old membership after the current one is canceled is refused (no revoke
// involved), while the first late event of a never seen membership still switches (case 9).
test('11 old membership replay after a cancel is refused', async (port) => {
  // Fixed times: a replay carries exactly the times of the event it repeats.
  const t40 = at(-40 * MIN);
  const t35 = at(-35 * MIN);
  const replays = [
    ['activation replay', (e) => membershipEvent('membership.activated', e, 'mem_c11_a', 'active', t40)],
    ['went_valid replay', (e) => membershipEvent('membership.went_valid', e, 'mem_c11_a', 'active', t40)],
    ['payment replay', (e) => paymentEvent(e, 'mem_c11_a', t35)],
    ['older payment of the old membership', (e) => paymentEvent(e, 'mem_c11_a', at(-38 * MIN))],
  ];
  let i = 0;
  for (const [label, make] of replays) {
    const email = `c11-${++i}@example.com`;
    seed(email, { status: 'pending', access: 0 });
    await postWebhook(port, membershipEvent('membership.activated', email, 'mem_c11_a', 'active', t40));
    await postWebhook(port, paymentEvent(email, 'mem_c11_a', t35));
    await postWebhook(port, membershipEvent('membership.activated', email, 'mem_c11_b', 'active', at(-30 * MIN)));
    await postWebhook(port, membershipEvent('membership.deactivated', email, 'mem_c11_b', 'canceled', at(-10 * MIN)));
    const before = row(email);
    assert.strictEqual(before.access_granted, 0, `11 ${label}: current membership cancel applies`);
    const from = captured.length;
    await postWebhook(port, make(email));
    const r = row(email);
    assert.strictEqual(r.access_granted, 0, `11 ${label}: replay does not re grant`);
    assert.strictEqual(r.status, 'canceled', `11 ${label}: status stays canceled`);
    assert.strictEqual(r.whop_membership_id, 'mem_c11_b', `11 ${label}: membership unchanged`);
    assert.deepStrictEqual(mailTo(from, email), [], `11 ${label}: no email`);
  }
  // History records every membership with its newest time.
  const times = JSON.parse(row('c11-1@example.com').whop_membership_times);
  assert.deepStrictEqual(Object.keys(times).sort(), ['mem_c11_a', 'mem_c11_b'], '11 history has both memberships');
});

async function main() {
  const { server, port } = await listen();
  const results = [];
  try {
    for (const [name, fn] of cases) {
      try {
        await fn(port);
        results.push([name, 'PASS']);
      } catch (err) {
        results.push([name, 'FAIL', err && err.message]);
      }
    }
  } finally {
    console.log = origLog;
    await new Promise((resolve) => server.close(resolve));
    try { db.close(); } catch (e) {}
    cleanDb();
  }
  for (const [name, verdict, why] of results) console.log(`[case] ${verdict} ${name}${why ? `: ${why}` : ''}`);
  if (results.some((r) => r[1] !== 'PASS')) {
    console.error('lib/admin-revoke-whop.test.js failed');
    process.exit(1);
  }
  console.log('lib/admin-revoke-whop.test.js passed');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
