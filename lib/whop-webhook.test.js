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
    INSERT INTO users (email, status, access_granted, trial_end, whop_membership_id, stripe_subscription_id)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(
    email,
    fields.status || 'active',
    fields.access_granted == null ? 1 : fields.access_granted,
    fields.trial_end || null,
    fields.whop_membership_id || null,
    fields.stripe_subscription_id || null
  );
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
        whop_membership_id TEXT,
        stripe_subscription_id TEXT,
        stripe_customer_id TEXT
      );
    `);
    const add = fixtureDb.prepare(`
      INSERT INTO users (email, status, trial_end, whop_membership_id, stripe_subscription_id, stripe_customer_id)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    add.run('a@example.com', 'trialing', '2020-01-01T00:00:00.000Z', 'mem_a', null, null);
    add.run('b@example.com', 'trialing', '2020-01-01T00:00:00.000Z', null, 'sub_b', null);
    add.run('c@example.com', 'trialing', '2020-01-01T00:00:00.000Z', null, null, null);
    add.run('d@example.com', 'trialing', '2099-01-01T00:00:00.000Z', 'mem_d', null, null);
    add.run('e@example.com', 'active', '2020-01-01T00:00:00.000Z', 'mem_e', null, null);
    fixtureDb.close();
    const counted = spawnSync(process.execPath, [
      path.join(__dirname, '..', 'scripts', 'count-expired-trialing.js'),
      fixture,
    ], { encoding: 'utf8' });
    assert.strictEqual(counted.status, 0, 'count script exits 0');
    assert.ok(!/@/.test(counted.stdout), 'count script prints no email');
    assert.ok(!/mem_|sub_/.test(counted.stdout), 'count script prints no ids');
    assert.ok(counted.stdout.includes('expired_trialing=3'), counted.stdout);
    assert.ok(counted.stdout.includes('with_payment_or_membership_signal=2'), counted.stdout);

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
