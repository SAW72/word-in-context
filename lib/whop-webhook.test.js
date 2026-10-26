'use strict';
/**
 * Whop webhook correctness. Each case is meant to fail on main before the fix.
 * No production DB, no real email, no Whop API.
 */
const assert = require('assert');
const { spawnSync } = require('child_process');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const jwt = require('jsonwebtoken');
const { Webhook } = require('standardwebhooks');

const dbFile = path.join(os.tmpdir(), `wic-whop-webhook-${process.pid}.db`);
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
delete process.env.WIC_ENFORCE_TRIAL_END;

const { app, db } = require('../server');
const wh = new Webhook(WEBHOOK_SECRET);

const captured = [];
const origLog = console.log;
const origWarn = console.warn;
console.log = (...args) => {
  const line = args.map((a) => (typeof a === 'string' ? a : '')).join(' ');
  captured.push(line);
  if (line.includes('MAGIC LINK') || line.includes('token=')) return;
  origLog(...args);
};
console.warn = (...args) => {
  const line = args.map((a) => (typeof a === 'string' ? a : '')).join(' ');
  captured.push(line);
  origWarn(...args);
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
function postWebhook(port, event, webhookId) {
  const id = webhookId || ('msg_' + (++msgN));
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
    INSERT INTO users (email, status, access_granted, trial_end, whop_membership_id, stripe_subscription_id, manual_free)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    email,
    fields.status || 'active',
    fields.access_granted == null ? 1 : fields.access_granted,
    fields.trial_end || null,
    fields.whop_membership_id || null,
    fields.stripe_subscription_id || null,
    fields.manual_free ? 1 : 0
  );
}

function tokenCount(email) {
  return db.prepare('SELECT COUNT(*) AS n FROM magic_tokens WHERE email = ?').get(email).n;
}

function bearerFor(email) {
  const row = userRow(email);
  return jwt.sign({ email, id: row.id }, process.env.JWT_SECRET, { expiresIn: '1h' });
}

async function meStatus(port, email) {
  const res = await request(port, {
    method: 'GET',
    path: '/api/me',
    headers: { Authorization: 'Bearer ' + bearerFor(email) },
  });
  return res.status;
}

async function flagWouldCut(port, email) {
  const headers = { Authorization: 'Bearer ' + bearerFor(email) };
  const prev = process.env.WIC_ENFORCE_TRIAL_END;
  delete process.env.WIC_ENFORCE_TRIAL_END;
  const off = await request(port, { method: 'GET', path: '/api/me', headers });
  process.env.WIC_ENFORCE_TRIAL_END = '1';
  const on = await request(port, { method: 'GET', path: '/api/me', headers });
  if (prev == null) delete process.env.WIC_ENFORCE_TRIAL_END;
  else process.env.WIC_ENFORCE_TRIAL_END = prev;
  return off.status === 200 && on.status === 403;
}

async function main() {
  const { server, port } = await listen();
  try {
    // 1. payment.succeeded email lives on data.user, membership id on data.membership.
    insertUser('payer@example.com', { status: 'pending', access_granted: 0 });
    const pay = await postWebhook(port, {
      type: 'payment.succeeded',
      data: {
        id: 'pay_realistic_1',
        status: 'paid',
        user: { id: 'user_payer', email: 'payer@example.com' },
        membership: { id: 'mem_realistic_1' },
        plan: { id: PLAN },
      },
    });
    assert.strictEqual(pay.status, 200, 'payment.succeeded returns 200');
    const payer = userRow('payer@example.com');
    assert.strictEqual(payer.access_granted, 1, 'payment.succeeded grants access from data.user.email');
    assert.strictEqual(payer.whop_membership_id, 'mem_realistic_1', 'payment.succeeded stores the membership id, not the payment id');
    assert.notStrictEqual(payer.status, 'pending');

    // 2. Repeated webhook-id does not send another login link.
    const dupId = 'msg_duplicate_delivery';
    const dupEvent = {
      type: 'membership.activated',
      data: {
        id: 'mem_dup',
        status: 'trialing',
        user: { email: 'dup@example.com' },
        plan: { id: PLAN },
      },
    };
    const first = await postWebhook(port, dupEvent, dupId);
    const second = await postWebhook(port, dupEvent, dupId);
    assert.strictEqual(first.status, 200);
    assert.strictEqual(second.status, 200, 'repeated delivery is a 200');
    const dupTokens = db.prepare('SELECT COUNT(*) AS n FROM magic_tokens WHERE email = ?').get('dup@example.com');
    assert.strictEqual(dupTokens.n, 1, 'repeated delivery does not write another login token');

    // 3. membership.updated applies the same status mapping.
    insertUser('updated@example.com', { status: 'active', access_granted: 1, whop_membership_id: 'mem_updated' });
    const updated = await postWebhook(port, {
      type: 'membership.updated',
      data: {
        id: 'mem_updated',
        status: 'canceled',
        user: { email: 'updated@example.com' },
        plan: { id: PLAN },
      },
    });
    assert.strictEqual(updated.status, 200);
    const updatedRow = userRow('updated@example.com');
    assert.strictEqual(updatedRow.access_granted, 0, 'membership.updated cancel removes access');
    assert.strictEqual(updatedRow.status, 'canceled', 'membership.updated cancel maps like other membership events');

    insertUser('invalid@example.com', { status: 'active', access_granted: 1, whop_membership_id: 'mem_invalid' });
    const went = await postWebhook(port, {
      type: 'membership.went_invalid',
      data: {
        id: 'mem_invalid',
        status: 'active',
        user: { email: 'invalid@example.com' },
        plan: { id: PLAN },
      },
    });
    assert.strictEqual(went.status, 200);
    const invalidRow = userRow('invalid@example.com');
    assert.strictEqual(invalidRow.access_granted, 0, 'membership.went_invalid removes access');
    assert.strictEqual(invalidRow.status, 'canceled');

    // 4. Unknown status does not grant or deny. drafted does not grant a user without access.
    insertUser('unknown@example.com', { status: 'free', access_granted: 1, whop_membership_id: 'mem_unknown' });
    const beforeUnknown = captured.length;
    await postWebhook(port, {
      type: 'membership.updated',
      data: {
        id: 'mem_unknown',
        status: 'bogus',
        user: { email: 'unknown@example.com' },
        plan: { id: PLAN },
      },
    });
    const unknownRow = userRow('unknown@example.com');
    assert.strictEqual(unknownRow.status, 'free', 'unknown Whop status leaves the current status');
    assert.strictEqual(unknownRow.access_granted, 1, 'unknown Whop status does not deny access');
    assert.ok(captured.slice(beforeUnknown).some((line) => /unknown/i.test(line)), 'unknown status writes a warn log');

    insertUser('drafted@example.com', { status: 'pending', access_granted: 0 });
    await postWebhook(port, {
      type: 'membership.activated',
      data: {
        id: 'mem_drafted',
        status: 'drafted',
        user: { email: 'drafted@example.com' },
        plan: { id: PLAN },
      },
    });
    const drafted = userRow('drafted@example.com');
    assert.strictEqual(drafted.access_granted, 0, 'drafted does not grant access');
    assert.strictEqual(drafted.status, 'pending', 'drafted does not replace the current status');

    // 5. Missing plan id is refused only when an allowlist is configured.
    process.env.WHOP_PLAN_IDS = 'plan_only_this';
    insertUser('noplan@example.com', { status: 'pending', access_granted: 0 });
    await postWebhook(port, {
      type: 'membership.activated',
      data: {
        id: 'mem_noplan',
        status: 'trialing',
        user: { email: 'noplan@example.com' },
      },
    });
    const noplan = userRow('noplan@example.com');
    assert.strictEqual(noplan.access_granted, 0, 'missing plan id is refused when an allowlist is set');
    assert.strictEqual(noplan.status, 'pending');

    process.env.WHOP_PLAN_IDS = ',';
    insertUser('noallow@example.com', { status: 'pending', access_granted: 0 });
    await postWebhook(port, {
      type: 'membership.activated',
      data: {
        id: 'mem_noallow',
        status: 'trialing',
        user: { email: 'noallow@example.com' },
      },
    });
    const noallow = userRow('noallow@example.com');
    assert.strictEqual(noallow.access_granted, 1, 'missing plan id is still allowed when no allowlist is configured');
    process.env.WHOP_PLAN_IDS = PLAN;

    // 6. An old membership cancel must not revoke a newer membership on the same email.
    insertUser('multi@example.com', { status: 'active', access_granted: 1, whop_membership_id: 'mem_new' });
    await postWebhook(port, {
      type: 'membership.deactivated',
      data: {
        id: 'mem_old',
        status: 'canceled',
        user: { email: 'multi@example.com' },
        plan: { id: PLAN },
      },
    });
    const multi = userRow('multi@example.com');
    assert.strictEqual(multi.access_granted, 1, 'cancelling an old membership does not revoke the active one');
    assert.strictEqual(multi.status, 'active');
    assert.strictEqual(multi.whop_membership_id, 'mem_new');

    // 7. Refund and dispute revoke the matching membership only.
    insertUser('refund@example.com', { status: 'active', access_granted: 1, whop_membership_id: 'mem_refund' });
    const refund = await postWebhook(port, {
      type: 'refund.created',
      data: {
        id: 'ref_1',
        membership: { id: 'mem_refund' },
        user: { email: 'refund@example.com' },
        plan: { id: PLAN },
      },
    });
    assert.strictEqual(refund.status, 200);
    const refunded = userRow('refund@example.com');
    assert.strictEqual(refunded.access_granted, 0, 'refund.created revokes that membership');
    assert.strictEqual(refunded.status, 'canceled');

    insertUser('dispute@example.com', { status: 'active', access_granted: 1, whop_membership_id: 'mem_live' });
    await postWebhook(port, {
      type: 'dispute.created',
      data: {
        id: 'dsp_1',
        membership: { id: 'mem_other' },
        user: { email: 'dispute@example.com' },
      },
    });
    const disputeMiss = userRow('dispute@example.com');
    assert.strictEqual(disputeMiss.access_granted, 1, 'a dispute for a different membership does not revoke the live one');
    await postWebhook(port, {
      type: 'dispute.created',
      data: {
        id: 'dsp_2',
        membership: { id: 'mem_live' },
        user: { email: 'dispute@example.com' },
      },
    });
    const disputeHit = userRow('dispute@example.com');
    assert.strictEqual(disputeHit.access_granted, 0, 'dispute.created revokes the matching membership');

    // 8. Missing email service key must not log the login link or token.
    const logAt = captured.length;
    await postWebhook(port, {
      type: 'membership.activated',
      data: {
        id: 'mem_log',
        status: 'active',
        user: { email: 'log@example.com' },
        plan: { id: PLAN },
      },
    });
    const logged = captured.slice(logAt).join('\n');
    const stored = db.prepare('SELECT token FROM magic_tokens WHERE email = ?').get('log@example.com');
    assert.ok(stored && stored.token, 'a login token is still stored for delivery');
    assert.strictEqual(/login\?token=/.test(logged), false, 'logs do not contain a login link');
    assert.strictEqual(logged.includes(stored.token), false, 'logs do not contain the token');
    assert.ok(/email service key missing/i.test(logged), 'logs a redacted notice when the email key is missing');

    // 9. Retracted: past_due stays denied by requireAuth, same as main.
    insertUser('pastdue-auth@example.com', {
      status: 'past_due',
      access_granted: 1,
      trial_end: '2027-01-01T00:00:00.000Z',
    });
    const pastDueJwt = jwt.sign(
      { email: 'pastdue-auth@example.com', id: userRow('pastdue-auth@example.com').id },
      process.env.JWT_SECRET,
      { expiresIn: '1h' }
    );
    const mePast = await request(port, {
      method: 'GET',
      path: '/api/me',
      headers: { Authorization: 'Bearer ' + pastDueJwt },
    });
    assert.strictEqual(mePast.status, 403, 'past_due stays denied on /api/me');
    const chatPast = await request(port, {
      method: 'POST',
      path: '/api/chat',
      headers: { Authorization: 'Bearer ' + pastDueJwt, 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages: [{ role: 'user', content: 'hello' }] }),
    });
    assert.strictEqual(chatPast.status, 403, 'past_due stays denied on /api/chat');
    const sharePast = await request(port, {
      method: 'POST',
      path: '/api/share-transcode',
      headers: { Authorization: 'Bearer ' + pastDueJwt, 'Content-Type': 'application/octet-stream' },
      body: Buffer.from('nope'),
    });
    assert.strictEqual(sharePast.status, 403, 'past_due stays denied on /api/share-transcode');

    // 10. Trial-end enforcement is off unless WIC_ENFORCE_TRIAL_END is on.
    const admin = await request(port, {
      method: 'POST',
      path: '/api/admin/login',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: process.env.ADMIN_PASSWORD }),
    });
    assert.strictEqual(admin.status, 200, 'admin login works for the tester fixture');
    const tester = await request(port, {
      method: 'POST',
      path: '/api/admin/create-special-tester',
      headers: {
        Authorization: 'Bearer ' + admin.json.token,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ email: 'tester-expired@example.com', days: 14 }),
    });
    assert.strictEqual(tester.status, 200, 'create-special-tester creates the tester');
    const testerFresh = userRow('tester-expired@example.com');
    assert.strictEqual(testerFresh.status, 'trialing');
    const testerDays = (Date.parse(testerFresh.trial_end) - Date.now()) / 86400000;
    assert.ok(testerDays > 13 && testerDays < 15, 'tester trial_end is about 14 days');
    db.prepare(`UPDATE users SET trial_end = ? WHERE email = ?`).run(
      '2020-01-01T00:00:00.000Z',
      'tester-expired@example.com'
    );
    const testerJwt = jwt.sign(
      { email: 'tester-expired@example.com', id: testerFresh.id },
      process.env.JWT_SECRET,
      { expiresIn: '1h' }
    );
    delete process.env.WIC_ENFORCE_TRIAL_END;
    const testerOff = await request(port, {
      method: 'GET',
      path: '/api/me',
      headers: { Authorization: 'Bearer ' + testerJwt },
    });
    assert.strictEqual(testerOff.status, 200, 'flag off: an expired tester keeps access');

    insertUser('expired-trial@example.com', {
      status: 'trialing',
      access_granted: 1,
      trial_end: '2020-01-01T00:00:00.000Z',
    });
    const expiredJwt = jwt.sign(
      { email: 'expired-trial@example.com', id: userRow('expired-trial@example.com').id },
      process.env.JWT_SECRET,
      { expiresIn: '1h' }
    );
    const expiredOff = await request(port, {
      method: 'GET',
      path: '/api/me',
      headers: { Authorization: 'Bearer ' + expiredJwt },
    });
    assert.strictEqual(expiredOff.status, 200, 'flag off: expired trialing matches main');

    process.env.WIC_ENFORCE_TRIAL_END = '1';
    const expiredOn = await request(port, {
      method: 'GET',
      path: '/api/me',
      headers: { Authorization: 'Bearer ' + expiredJwt },
    });
    assert.strictEqual(expiredOn.status, 403, 'flag on: expired trialing is refused');
    const testerOn = await request(port, {
      method: 'GET',
      path: '/api/me',
      headers: { Authorization: 'Bearer ' + testerJwt },
    });
    assert.strictEqual(testerOn.status, 403, 'flag on: an expired tester is refused');
    delete process.env.WIC_ENFORCE_TRIAL_END;
    const expiredOffAgain = await request(port, {
      method: 'GET',
      path: '/api/me',
      headers: { Authorization: 'Bearer ' + expiredJwt },
    });
    assert.strictEqual(expiredOffAgain.status, 200, 'unsetting the flag restores main behavior');

    // 11. Membership past_due keeps access and stores status past_due (same outcome as payment.failed).
    insertUser('pastdue-mem@example.com', { status: 'active', access_granted: 1, whop_membership_id: 'mem_pd' });
    const pastDueEvent = await postWebhook(port, {
      type: 'membership.updated',
      data: {
        id: 'mem_pd',
        status: 'past_due',
        user: { email: 'pastdue-mem@example.com' },
        plan: { id: PLAN },
      },
    });
    assert.strictEqual(pastDueEvent.status, 200);
    const pdMem = userRow('pastdue-mem@example.com');
    assert.strictEqual(pdMem.status, 'past_due', 'membership past_due stores status past_due');
    assert.strictEqual(pdMem.access_granted, 1, 'membership past_due leaves access_granted as it was');

    async function expectManualFreeKeepsAccess(email, event) {
      const res = await postWebhook(port, event);
      assert.strictEqual(res.status, 200, email + ' webhook returns 200');
      const row = userRow(email);
      assert.strictEqual(row.manual_free, 1, email + ' stays manual_free');
      assert.strictEqual(row.access_granted, 1, email + ' manual_free access stays granted');
      assert.strictEqual(await meStatus(port, email), 200, email + ' /api/me stays 200');
    }

    // 1. manual_free is never cut off by cancel, expired, refund, dispute, or the email fallback.
    insertUser('mf-cancel-id@example.com', { status: 'active', access_granted: 1, manual_free: 1, whop_membership_id: 'mem_mf_cancel' });
    await expectManualFreeKeepsAccess('mf-cancel-id@example.com', {
      type: 'membership.updated',
      data: { id: 'mem_mf_cancel', status: 'canceled', user: { email: 'mf-cancel-id@example.com' }, plan: { id: PLAN } },
    });
    insertUser('mf-cancel-email@example.com', { status: 'active', access_granted: 1, manual_free: 1 });
    await expectManualFreeKeepsAccess('mf-cancel-email@example.com', {
      type: 'membership.updated',
      data: { id: 'mem_mf_cancel_email', status: 'canceled', user: { email: 'mf-cancel-email@example.com' }, plan: { id: PLAN } },
    });
    insertUser('mf-expired-id@example.com', { status: 'active', access_granted: 1, manual_free: 1, whop_membership_id: 'mem_mf_exp' });
    await expectManualFreeKeepsAccess('mf-expired-id@example.com', {
      type: 'membership.updated',
      data: { id: 'mem_mf_exp', status: 'expired', user: { email: 'mf-expired-id@example.com' }, plan: { id: PLAN } },
    });
    insertUser('mf-refund-id@example.com', { status: 'active', access_granted: 1, manual_free: 1, whop_membership_id: 'mem_mf_refund' });
    await expectManualFreeKeepsAccess('mf-refund-id@example.com', {
      type: 'refund.created',
      data: { id: 'ref_mf', membership: { id: 'mem_mf_refund' }, user: { email: 'mf-refund-id@example.com' }, plan: { id: PLAN } },
    });
    insertUser('mf-refund-email@example.com', { status: 'active', access_granted: 1, manual_free: 1 });
    await expectManualFreeKeepsAccess('mf-refund-email@example.com', {
      type: 'refund.created',
      data: { id: 'ref_mf_email', membership: { id: 'mem_mf_refund_email' }, user: { email: 'mf-refund-email@example.com' }, plan: { id: PLAN } },
    });
    insertUser('mf-dispute-id@example.com', { status: 'active', access_granted: 1, manual_free: 1, whop_membership_id: 'mem_mf_dispute' });
    await expectManualFreeKeepsAccess('mf-dispute-id@example.com', {
      type: 'dispute.created',
      data: { id: 'dsp_mf', membership: { id: 'mem_mf_dispute' }, user: { email: 'mf-dispute-id@example.com' }, plan: { id: PLAN } },
    });
    insertUser('mf-dispute-email@example.com', { status: 'active', access_granted: 1, manual_free: 1 });
    await expectManualFreeKeepsAccess('mf-dispute-email@example.com', {
      type: 'dispute.created',
      data: { id: 'dsp_mf_email', membership: { id: 'mem_mf_dispute_email' }, user: { email: 'mf-dispute-email@example.com' } },
    });

    // 2. payment.succeeded with no membership object, or a string membership id, uses the grant plan check.
    insertUser('foreign-nomem@example.com', { status: 'canceled', access_granted: 0 });
    const foreignNoMem = await postWebhook(port, {
      type: 'payment.succeeded',
      data: {
        id: 'pay_foreign_nomem',
        status: 'paid',
        user: { email: 'foreign-nomem@example.com' },
        plan: { id: 'plan_other_product' },
      },
    });
    assert.strictEqual(foreignNoMem.status, 200);
    const foreignNoMemRow = userRow('foreign-nomem@example.com');
    assert.strictEqual(foreignNoMemRow.status, 'canceled', 'a canceled user paying on another plan stays canceled');
    assert.strictEqual(foreignNoMemRow.access_granted, 0, 'a foreign-plan payment does not grant access');

    insertUser('foreign-str@example.com', { status: 'canceled', access_granted: 0, whop_membership_id: 'mem_kept' });
    await postWebhook(port, {
      type: 'payment.succeeded',
      data: {
        id: 'pay_foreign_str',
        status: 'paid',
        user: { email: 'foreign-str@example.com' },
        membership: 'mem_other_string',
        plan: { id: 'plan_other_product' },
      },
    });
    const foreignStr = userRow('foreign-str@example.com');
    assert.strictEqual(foreignStr.status, 'canceled', 'a string membership id still passes the plan check');
    assert.strictEqual(foreignStr.access_granted, 0);
    assert.strictEqual(foreignStr.whop_membership_id, 'mem_kept');

    insertUser('bare-pay@example.com', { status: 'pending', access_granted: 0 });
    await postWebhook(port, {
      type: 'payment.succeeded',
      data: {
        id: 'pay_bare',
        status: 'paid',
        user: { email: 'bare-pay@example.com' },
        plan: { id: PLAN },
      },
    });
    const barePay = userRow('bare-pay@example.com');
    assert.strictEqual(barePay.access_granted, 1, 'payment.succeeded with no membership object grants an allowlisted plan');
    assert.strictEqual(barePay.status, 'active');

    insertUser('str-pay@example.com', { status: 'pending', access_granted: 0 });
    await postWebhook(port, {
      type: 'payment.succeeded',
      data: {
        id: 'pay_str',
        status: 'paid',
        user: { email: 'str-pay@example.com' },
        membership: 'mem_string_1',
        plan_id: PLAN,
      },
    });
    const strPay = userRow('str-pay@example.com');
    assert.strictEqual(strPay.access_granted, 1, 'a string membership id on an allowlisted plan grants access');
    assert.strictEqual(strPay.whop_membership_id, 'mem_string_1', 'a string membership id is stored');
    assert.notStrictEqual(strPay.whop_membership_id, 'pay_str');

    // 3. A missing plan id blocks a grant only. Revokes with no plan id still revoke, except manual_free.
    insertUser('deact-noplan@example.com', { status: 'active', access_granted: 1, whop_membership_id: 'mem_deact_np' });
    await postWebhook(port, {
      type: 'membership.deactivated',
      data: { id: 'mem_deact_np', user: { email: 'deact-noplan@example.com' } },
    });
    const deactNoPlan = userRow('deact-noplan@example.com');
    assert.strictEqual(deactNoPlan.access_granted, 0, 'membership.deactivated with no plan id still revokes');
    assert.strictEqual(deactNoPlan.status, 'canceled');

    insertUser('cancel-noplan@example.com', { status: 'active', access_granted: 1, whop_membership_id: 'mem_cancel_np' });
    await postWebhook(port, {
      type: 'membership.updated',
      data: { id: 'mem_cancel_np', status: 'canceled', user: { email: 'cancel-noplan@example.com' } },
    });
    const cancelNoPlan = userRow('cancel-noplan@example.com');
    assert.strictEqual(cancelNoPlan.access_granted, 0, 'cancel with no plan id still revokes');
    assert.strictEqual(cancelNoPlan.status, 'canceled');

    insertUser('refund-noplan@example.com', { status: 'active', access_granted: 1, whop_membership_id: 'mem_refund_np' });
    await postWebhook(port, {
      type: 'refund.created',
      data: { id: 'ref_np', membership: { id: 'mem_refund_np' }, user: { email: 'refund-noplan@example.com' } },
    });
    const refundNoPlan = userRow('refund-noplan@example.com');
    assert.strictEqual(refundNoPlan.access_granted, 0, 'refund with no plan id still revokes the matching membership');
    assert.strictEqual(refundNoPlan.status, 'canceled');

    insertUser('dispute-noplan@example.com', { status: 'active', access_granted: 1, whop_membership_id: 'mem_dispute_np' });
    await postWebhook(port, {
      type: 'dispute.created',
      data: { id: 'dsp_np', membership_id: 'mem_dispute_np', user: { email: 'dispute-noplan@example.com' } },
    });
    const disputeNoPlan = userRow('dispute-noplan@example.com');
    assert.strictEqual(disputeNoPlan.access_granted, 0, 'dispute with no plan id still revokes the matching membership');

    insertUser('mf-deact-noplan@example.com', { status: 'active', access_granted: 1, manual_free: 1, whop_membership_id: 'mem_mf_deact_np' });
    await expectManualFreeKeepsAccess('mf-deact-noplan@example.com', {
      type: 'membership.deactivated',
      data: { id: 'mem_mf_deact_np', user: { email: 'mf-deact-noplan@example.com' } },
    });
    insertUser('mf-deact-plan@example.com', { status: 'active', access_granted: 1, manual_free: 1, whop_membership_id: 'mem_mf_deact' });
    await expectManualFreeKeepsAccess('mf-deact-plan@example.com', {
      type: 'membership.deactivated',
      data: { id: 'mem_mf_deact', user: { email: 'mf-deact-plan@example.com' }, plan: { id: PLAN } },
    });

    // 4. refund and dispute do not revoke by email when there is no membership match.
    insertUser('pay-nomem@example.com', { status: 'active', access_granted: 1 });
    await postWebhook(port, {
      type: 'refund.created',
      data: {
        id: 'ref_nomem',
        membership: { id: 'mem_some_other' },
        user: { email: 'pay-nomem@example.com' },
        plan: { id: PLAN },
      },
    });
    const payNoMem = userRow('pay-nomem@example.com');
    assert.strictEqual(payNoMem.access_granted, 1, 'a refund does not revoke a paying user with no stored membership id');
    assert.strictEqual(payNoMem.status, 'active');
    assert.strictEqual(payNoMem.whop_membership_id, null);

    insertUser('other-product@example.com', { status: 'active', access_granted: 1 });
    await postWebhook(port, {
      type: 'dispute.created',
      data: {
        id: 'dsp_other_prod',
        membership: { id: 'mem_other_product' },
        user: { email: 'other-product@example.com' },
        plan: { id: 'plan_other_product' },
      },
    });
    const otherProduct = userRow('other-product@example.com');
    assert.strictEqual(otherProduct.access_granted, 1, 'a dispute for another Whop product does not revoke by email');
    assert.strictEqual(otherProduct.status, 'active');

    insertUser('refund-nomatch@example.com', { status: 'active', access_granted: 1, whop_membership_id: 'mem_live_refund' });
    await postWebhook(port, {
      type: 'refund.created',
      data: {
        id: 'ref_other_prod',
        membership: { id: 'mem_other_product_refund' },
        user: { email: 'refund-nomatch@example.com' },
        plan: { id: 'plan_other_product' },
      },
    });
    const refundNoMatch = userRow('refund-nomatch@example.com');
    assert.strictEqual(refundNoMatch.access_granted, 1, 'a refund for another membership does not revoke the live one');
    assert.strictEqual(refundNoMatch.whop_membership_id, 'mem_live_refund');

    // 5. A repeat payment.succeeded does not send another trial-ready email.
    insertUser('renew@example.com', { status: 'pending', access_granted: 0 });
    for (let i = 0; i < 3; i++) {
      const renewRes = await postWebhook(port, {
        type: 'payment.succeeded',
        data: {
          id: 'pay_renew_' + i,
          user: { email: 'renew@example.com' },
          membership: { id: 'mem_renew', status: 'active' },
          plan: { id: PLAN },
        },
      });
      assert.strictEqual(renewRes.status, 200);
    }
    assert.strictEqual(userRow('renew@example.com').access_granted, 1);
    assert.strictEqual(tokenCount('renew@example.com'), 1, 'three payments send at most one trial-ready email');

    insertUser('renew-active@example.com', { status: 'active', access_granted: 1, whop_membership_id: 'mem_renew_a' });
    for (let i = 0; i < 3; i++) {
      await postWebhook(port, {
        type: 'payment.succeeded',
        data: {
          id: 'pay_renew_a_' + i,
          user: { email: 'renew-active@example.com' },
          membership: { id: 'mem_renew_a', status: 'active' },
          plan: { id: PLAN },
        },
      });
    }
    assert.strictEqual(tokenCount('renew-active@example.com'), 0, 'a renewal for an already-active user does not send another trial-ready email');
    assert.strictEqual(userRow('renew-active@example.com').access_granted, 1);

    // 7. Mutant locks.
    const origPrepare = db.prepare;
    let armHandlerError = true;
    db.prepare = function (sql) {
      const stmt = origPrepare.call(db, sql);
      if (!armHandlerError || typeof sql !== 'string' || !/INSERT INTO users/i.test(sql)) return stmt;
      const origRun = stmt.run.bind(stmt);
      stmt.run = function (...args) {
        if (args[0] === 'm2b-error@example.com') throw new Error('sentinel handler failure');
        return origRun(...args);
      };
      return stmt;
    };
    let boom;
    try {
      boom = await postWebhook(port, {
        type: 'membership.activated',
        data: {
          id: 'mem_m2b',
          status: 'active',
          user: { email: 'm2b-error@example.com' },
          plan: { id: PLAN },
        },
      }, 'msg_m2b_retry');
    } finally {
      armHandlerError = false;
      db.prepare = origPrepare;
    }
    assert.strictEqual(boom.status, 500, 'M2b: handler error returns 500');
    assert.strictEqual(userRow('m2b-error@example.com'), undefined, 'M2b: failed handler does not leave the user');
    const m2bRetry = await postWebhook(port, {
      type: 'membership.activated',
      data: {
        id: 'mem_m2b',
        status: 'active',
        user: { email: 'm2b-error@example.com' },
        plan: { id: PLAN },
      },
    }, 'msg_m2b_retry');
    assert.strictEqual(m2bRetry.status, 200, 'M2b: the same webhook-id is accepted after the handler error');
    const m2bUser = userRow('m2b-error@example.com');
    assert.ok(m2bUser, 'M2b: retry creates the user');
    assert.strictEqual(m2bUser.access_granted, 1);

    insertUser('empty-status@example.com', { status: 'pending', access_granted: 0 });
    await postWebhook(port, {
      type: 'membership.activated',
      data: {
        id: 'mem_empty_status',
        status: '',
        user: { email: 'empty-status@example.com' },
        plan: { id: PLAN },
      },
    });
    const emptyStatus = userRow('empty-status@example.com');
    assert.strictEqual(emptyStatus.access_granted, 0, 'M4c: an empty status does not grant access');
    assert.strictEqual(emptyStatus.status, 'pending', 'M4c: an empty status does not map to active');

    insertUser('mf-flag@example.com', {
      status: 'trialing',
      access_granted: 1,
      manual_free: 1,
      trial_end: '2020-01-01T00:00:00.000Z',
    });
    process.env.WIC_ENFORCE_TRIAL_END = '1';
    assert.strictEqual(await meStatus(port, 'mf-flag@example.com'), 200, 'M10c: flag on still allows manual_free after trial_end');
    delete process.env.WIC_ENFORCE_TRIAL_END;

    for (const value of ['0', 'false', 'off']) {
      process.env.WIC_ENFORCE_TRIAL_END = value;
      assert.strictEqual(
        await meStatus(port, 'expired-trial@example.com'),
        200,
        'M10d: WIC_ENFORCE_TRIAL_END=' + value + ' does not enforce trial end'
      );
    }
    delete process.env.WIC_ENFORCE_TRIAL_END;

    const countRows = [
      { email: 'a@example.com', status: 'trialing', trial_end: '2020-01-01T00:00:00.000Z', whop_membership_id: 'mem_a', stripe_subscription_id: null, stripe_customer_id: null, access_granted: 1, manual_free: 0, cut: true },
      { email: 'b@example.com', status: 'trialing', trial_end: '2020-01-01T00:00:00.000Z', whop_membership_id: null, stripe_subscription_id: 'sub_b', stripe_customer_id: null, access_granted: 1, manual_free: 0, cut: true },
      { email: 'c@example.com', status: 'trialing', trial_end: '2020-01-01T00:00:00.000Z', whop_membership_id: null, stripe_subscription_id: null, stripe_customer_id: null, access_granted: 1, manual_free: 0, cut: true },
      { email: 'd@example.com', status: 'trialing', trial_end: '2099-01-01T00:00:00.000Z', whop_membership_id: 'mem_d', stripe_subscription_id: null, stripe_customer_id: null, access_granted: 1, manual_free: 0, cut: false },
      { email: 'e@example.com', status: 'active', trial_end: '2020-01-01T00:00:00.000Z', whop_membership_id: 'mem_e', stripe_subscription_id: null, stripe_customer_id: null, access_granted: 1, manual_free: 0, cut: false },
      { email: 'f@example.com', status: 'trialing', trial_end: null, whop_membership_id: null, stripe_subscription_id: null, stripe_customer_id: null, access_granted: 1, manual_free: 0, cut: true },
      { email: 'g@example.com', status: 'trialing', trial_end: 'not-a-date', whop_membership_id: null, stripe_subscription_id: null, stripe_customer_id: null, access_granted: 1, manual_free: 0, cut: true },
      { email: 'h@example.com', status: 'trialing', trial_end: '2020-01-01T00:00:00.000Z', whop_membership_id: 'mem_h', stripe_subscription_id: null, stripe_customer_id: null, access_granted: 1, manual_free: 1, cut: false },
      { email: 'i@example.com', status: 'trialing', trial_end: '2020-01-01T00:00:00.000Z', whop_membership_id: 'mem_i', stripe_subscription_id: null, stripe_customer_id: null, access_granted: 0, manual_free: 0, cut: false },
      { email: 'j@example.com', status: 'trialing', trial_end: '', whop_membership_id: null, stripe_subscription_id: null, stripe_customer_id: null, access_granted: 1, manual_free: 0, cut: true },
    ];
    const insertCountRow = db.prepare(`
      INSERT INTO users (email, status, access_granted, trial_end, whop_membership_id, stripe_subscription_id, stripe_customer_id, manual_free)
      VALUES (@email, @status, @access_granted, @trial_end, @whop_membership_id, @stripe_subscription_id, @stripe_customer_id, @manual_free)
    `);
    let measuredCuts = 0;
    for (const row of countRows) {
      insertCountRow.run(row);
      const cut = await flagWouldCut(port, row.email);
      assert.strictEqual(cut, row.cut, row.email + ' flag differential');
      if (cut) measuredCuts += 1;
    }
    assert.strictEqual(measuredCuts, 6, 'the flag cuts null, empty, garbage, and past trials only');

    const fixture = path.join(os.tmpdir(), `wic-expired-count-${process.pid}.db`);
    try { fs.unlinkSync(fixture); } catch (e) {}
    const Database = require('better-sqlite3');
    const fixtureDb = new Database(fixture);
    fixtureDb.exec(`
      CREATE TABLE users (
        id INTEGER PRIMARY KEY,
        email TEXT,
        status TEXT,
        trial_end TEXT,
        access_granted INTEGER,
        manual_free INTEGER,
        whop_membership_id TEXT,
        stripe_subscription_id TEXT,
        stripe_customer_id TEXT
      );
    `);
    const add = fixtureDb.prepare(`
      INSERT INTO users (email, status, trial_end, access_granted, manual_free, whop_membership_id, stripe_subscription_id, stripe_customer_id)
      VALUES (@email, @status, @trial_end, @access_granted, @manual_free, @whop_membership_id, @stripe_subscription_id, @stripe_customer_id)
    `);
    for (const row of countRows) add.run(row);
    fixtureDb.close();

    function runCount(dbPath) {
      return spawnSync(process.execPath, [
        path.join(__dirname, '..', 'scripts', 'count-expired-trialing.js'),
        dbPath,
      ], { encoding: 'utf8' });
    }

    const counted = runCount(fixture);
    assert.strictEqual(counted.status, 0, counted.stderr || 'count script exits 0');
    assert.ok(!/@/.test(counted.stdout), 'count script prints no email');
    assert.ok(!/mem_|sub_/.test(counted.stdout), 'count script prints no ids');
    assert.ok(counted.stdout.includes('expired_trialing=' + measuredCuts), counted.stdout);
    assert.ok(counted.stdout.includes('expired_trialing=6'), counted.stdout);
    assert.ok(counted.stdout.includes('with_payment_or_membership_signal=2'), counted.stdout);

    fs.chmodSync(fixture, 0o444);
    try {
      const readonlyCount = runCount(fixture);
      assert.strictEqual(readonlyCount.status, 0, 'MC1: count script opens a read-only database');
      assert.ok(!/@/.test(readonlyCount.stdout), 'MC1: read-only count prints no email');
      assert.ok(readonlyCount.stdout.includes('expired_trialing=6'), readonlyCount.stdout || readonlyCount.stderr);
    } finally {
      fs.chmodSync(fixture, 0o644);
    }

    const refused = runCount('/data/users.db');
    assert.strictEqual(refused.status, 1, 'MC2: count script refuses /data/users.db');
    assert.strictEqual(refused.stdout, '', 'MC2: refusal prints nothing on stdout');
    assert.ok(/refusing to open a production database path/.test(refused.stderr || ''), refused.stderr || '');

    console.log = origLog;
    console.log('lib/whop-webhook.test.js passed');
  } finally {
    console.log = origLog;
    console.warn = origWarn;
    await new Promise((resolve) => server.close(resolve));
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
