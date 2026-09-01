'use strict';
/**
 * HTTP tests for password overwrite, trialDays cap/parameterization, and admin lockout.
 * Uses a temp SQLite file so the real users.db is never touched.
 */
const assert = require('assert');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const bcrypt = require('bcryptjs');

const dbFile = path.join(os.tmpdir(), `wic-auth-hardening-${process.pid}.db`);
for (const extra of [dbFile, dbFile + '-wal', dbFile + '-shm']) {
  try { fs.unlinkSync(extra); } catch (e) {}
}

process.env.NODE_ENV = 'test';
process.env.WIC_DB_PATH = dbFile;
process.env.JWT_SECRET = 'unit-test-jwt-secret-at-least-32-chars';
process.env.ADMIN_PASSWORD = 'unit-test-admin-password';
process.env.TESTER_INVITE_TOKEN = 'unit-test-invite-token-32chars!!';
process.env.ADMIN_LOCKOUT_MAX_ATTEMPTS = '3';
process.env.ADMIN_LOCKOUT_WINDOW_MS = '60000';
process.env.ADMIN_LOCKOUT_LOCK_MS = '250';
process.env.TESTER_SIGNUP_RATE_MAX = '30';
process.env.TESTER_SIGNUP_RATE_WINDOW_MS = '60000';
process.env.XAI_API_KEY = '';
process.env.WHOP_CHECKOUT_URL_MONTHLY = 'https://whop.com/checkout/test-plan';

const {
  app,
  db,
  adminLoginLockout,
  testerSignupLimiter,
  UPSERT_TRIAL_USER_SQL,
  activateWhopMembership,
  TRIAL_DAYS,
} = require('../server');
const { usesParameterizedTrialEnd } = require('./security');

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
    const payload = body == null ? null : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
    const req = http.request({
      hostname: '127.0.0.1',
      port,
      method,
      path: urlPath,
      headers: {
        ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': payload.length } : {}),
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

async function main() {
  const { server, port } = await listen();
  try {
    assert.ok(usesParameterizedTrialEnd(UPSERT_TRIAL_USER_SQL), 'exported insert SQL must stay parameterized');

    const oldHash = await bcrypt.hash('original-pass-9', 10);
    db.prepare(`
      INSERT INTO users (email, status, trial_end, access_granted, password_hash)
      VALUES (?, 'active', ?, 1, ?)
    `).run('existing@example.com', '2027-01-01T00:00:00.000Z', oldHash);

    // --- tester-signup: no invite, no JWT, no overwrite ---
    const noInvite = await request(port, {
      method: 'POST',
      path: '/api/tester-signup',
      body: { email: 'existing@example.com', password: 'attacker-pass-99' },
    });
    assert.strictEqual(noInvite.status, 403, 'tester-signup without invite must be gated');
    assert.ok(!noInvite.json || !noInvite.json.token, 'must not mint a JWT without invite');

    const overwriteTry = await request(port, {
      method: 'POST',
      path: '/api/tester-signup',
      body: {
        email: 'existing@example.com',
        password: 'attacker-pass-99',
        inviteToken: process.env.TESTER_INVITE_TOKEN,
      },
    });
    assert.strictEqual(overwriteTry.status, 409, 'existing user must not be rewritten');
    assert.ok(!overwriteTry.json || !overwriteTry.json.token, 'must not mint a JWT for an existing email');
    const afterTester = db.prepare('SELECT password_hash FROM users WHERE email = ?').get('existing@example.com');
    assert.strictEqual(afterTester.password_hash, oldHash, 'tester-signup must not overwrite password_hash');
    assert.ok(await bcrypt.compare('original-pass-9', afterTester.password_hash));

    db.prepare(`
      INSERT INTO users (email, status, access_granted, password_hash)
      VALUES (?, 'pending', 0, NULL)
    `).run('blankhash@example.com');

    // --- create-checkout: no overwrite (including blank hash), no pre-pay access ---
    const checkout = await request(port, {
      method: 'POST',
      path: '/api/create-checkout',
      body: {
        email: 'existing@example.com',
        password: 'attacker-pass-99',
        trialDays: 99999,
        billing: 'monthly',
      },
    });
    assert.strictEqual(checkout.status, 200, 'checkout should still proceed for existing users');
    assert.ok(checkout.json && checkout.json.url, 'checkout returns Whop URL');
    assert.strictEqual(checkout.json.trialDays, TRIAL_DAYS, 'response trialDays is server TRIAL_DAYS only');
    const afterCheckout = db.prepare('SELECT password_hash, trial_end, access_granted, status FROM users WHERE email = ?').get('existing@example.com');
    assert.strictEqual(afterCheckout.password_hash, oldHash, 'create-checkout must not overwrite password_hash');
    assert.strictEqual(afterCheckout.trial_end, '2027-01-01T00:00:00.000Z', 'existing trial_end must stay');
    assert.strictEqual(afterCheckout.access_granted, 1, 'existing access is not revoked at checkout create');

    const blankCheckout = await request(port, {
      method: 'POST',
      path: '/api/create-checkout',
      body: {
        email: 'blankhash@example.com',
        password: 'attacker-pass-99',
        trialDays: 99999,
        billing: 'monthly',
      },
    });
    assert.strictEqual(blankCheckout.status, 200);
    const afterBlank = db.prepare('SELECT password_hash, access_granted, status FROM users WHERE email = ?').get('blankhash@example.com');
    assert.strictEqual(afterBlank.password_hash, null, 'create-checkout must not fill a blank password_hash');
    assert.strictEqual(afterBlank.access_granted, 0, 'blank-hash existing user must not gain access at checkout create');
    assert.strictEqual(afterBlank.status, 'pending');

    const newCheckout = await request(port, {
      method: 'POST',
      path: '/api/create-checkout',
      body: {
        email: 'newbie@example.com',
        password: 'newcomer-pass-9',
        trialDays: 99999,
        billing: 'monthly',
      },
    });
    assert.strictEqual(newCheckout.status, 200);
    assert.strictEqual(newCheckout.json.trialDays, TRIAL_DAYS, 'client trialDays is ignored');
    const newbie = db.prepare('SELECT trial_end, password_hash, access_granted, status FROM users WHERE email = ?').get('newbie@example.com');
    assert.ok(newbie, 'new checkout user is created');
    assert.strictEqual(newbie.access_granted, 0, 'access is not granted before payment');
    assert.strictEqual(newbie.status, 'pending', 'pre-pay checkout user is pending, not trialing');
    assert.ok(!newbie.trial_end, 'trial_end is not set until the payment webhook');
    assert.ok(await bcrypt.compare('newcomer-pass-9', newbie.password_hash));

    await activateWhopMembership({
      status: 'trialing',
      id: 'mem_test_newbie',
      email: 'newbie@example.com',
    }, 'test', { sendLoginEmail: false });
    const afterPay = db.prepare('SELECT trial_end, access_granted, status, password_hash FROM users WHERE email = ?').get('newbie@example.com');
    assert.strictEqual(afterPay.access_granted, 1, 'Whop webhook grants access after payment');
    assert.strictEqual(afterPay.status, 'trialing');
    assert.ok(afterPay.trial_end, 'webhook sets trial_end from server TRIAL_DAYS when Whop omits renewal');
    const daysOut = (Date.parse(afterPay.trial_end) - Date.now()) / 86400000;
    assert.ok(daysOut <= TRIAL_DAYS + 1, `webhook trial_end must follow server TRIAL_DAYS, got ~${daysOut}`);
    assert.ok(daysOut >= TRIAL_DAYS - 1, `webhook trial_end should be about ${TRIAL_DAYS} days, got ~${daysOut}`);
    assert.ok(await bcrypt.compare('newcomer-pass-9', afterPay.password_hash), 'webhook must not change password_hash');

    // --- new tester with invite: no session JWT ---
    const fresh = await request(port, {
      method: 'POST',
      path: '/api/tester-signup',
      body: {
        email: 'fresh-tester@example.com',
        password: 'tester-pass-99',
        inviteToken: process.env.TESTER_INVITE_TOKEN,
      },
    });
    assert.strictEqual(fresh.status, 200, 'invited tester signup should succeed');
    assert.ok(!fresh.json.token, 'tester-signup must not mint a session JWT');
    assert.ok(fresh.json.email === 'fresh-tester@example.com');

    const headerOnlyInvite = await request(port, {
      method: 'POST',
      path: '/api/tester-signup',
      headers: { 'X-Tester-Invite': process.env.TESTER_INVITE_TOKEN },
      body: { email: 'header-only@example.com', password: 'tester-pass-99' },
    });
    assert.strictEqual(headerOnlyInvite.status, 403, 'invite header is not a bearer; landing POSTs inviteToken in JSON');
    const headerUser = db.prepare('SELECT id FROM users WHERE email = ?').get('header-only@example.com');
    assert.ok(!headerUser, 'header-only invite must not create a user');

    // --- admin lockout ---
    adminLoginLockout.reset();
    const bad1 = await request(port, { method: 'POST', path: '/api/admin/login', body: { password: 'nope-1' } });
    const bad2 = await request(port, { method: 'POST', path: '/api/admin/login', body: { password: 'nope-2' } });
    const bad3 = await request(port, { method: 'POST', path: '/api/admin/login', body: { password: 'nope-3' } });
    assert.strictEqual(bad1.status, 401);
    assert.strictEqual(bad2.status, 401);
    assert.strictEqual(bad3.status, 429, 'third failure must lock out');
    assert.ok(bad3.json && /too many/i.test(bad3.json.error || ''));

    const evenGood = await request(port, {
      method: 'POST',
      path: '/api/admin/login',
      body: { password: process.env.ADMIN_PASSWORD },
    });
    assert.strictEqual(evenGood.status, 429, 'correct password is still locked during backoff');

    await new Promise((r) => setTimeout(r, 300));
    const afterWait = await request(port, {
      method: 'POST',
      path: '/api/admin/login',
      body: { password: process.env.ADMIN_PASSWORD },
    });
    assert.strictEqual(afterWait.status, 200, 'lockout expires and good password works');
    assert.ok(afterWait.json && afterWait.json.token);

    // rate limit still counts without minting a session
    testerSignupLimiter.reset();
    for (const key of ['tester:127.0.0.1', 'tester:::ffff:127.0.0.1', 'tester::1']) {
      for (let i = 0; i < 30; i++) testerSignupLimiter.check(key);
    }
    const limited = await request(port, {
      method: 'POST',
      path: '/api/tester-signup',
      body: {
        email: 'rate@example.com',
        password: 'rate-limit-99',
        inviteToken: process.env.TESTER_INVITE_TOKEN,
      },
    });
    assert.strictEqual(limited.status, 429, 'tester-signup is rate limited');

    console.log('lib/auth-hardening.test.js passed');
  } finally {
    server.close();
    try { db.close(); } catch (e) {}
    for (const extra of [dbFile, dbFile + '-wal', dbFile + '-shm']) {
      try { fs.unlinkSync(extra); } catch (e) {}
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
