'use strict';
/**
 * Unverified checkout must not leave a password that can log in after payment.
 * The buyer gets in through the payment magic link, then sets a password.
 */
const assert = require('assert');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

const dbFile = path.join(os.tmpdir(), `wic-preclaim-${process.pid}.db`);
for (const extra of [dbFile, dbFile + '-wal', dbFile + '-shm']) {
  try { fs.unlinkSync(extra); } catch (e) {}
}

process.env.NODE_ENV = 'test';
process.env.WIC_DB_PATH = dbFile;
process.env.JWT_SECRET = 'unit-test-jwt-secret-at-least-32-chars';
process.env.ADMIN_PASSWORD = 'unit-test-admin-password';
process.env.TESTER_INVITE_TOKEN = 'unit-test-invite-token-32chars!!';
process.env.WHOP_CHECKOUT_URL_MONTHLY = 'https://whop.com/checkout/test-plan';
process.env.WHOP_CHECKOUT_URL_YEARLY = '';
process.env.XAI_API_KEY = '';

const origLog = console.log;
console.log = (...args) => {
  const line = args.map((a) => (typeof a === 'string' ? a : '')).join(' ');
  if (line.includes('MAGIC LINK') || line.includes('token=')) return;
  origLog(...args);
};

const { app, db, activateWhopMembership } = require('../server');

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
    const oldHash = await bcrypt.hash('original-pass-9', 10);
    db.prepare(`
      INSERT INTO users (email, status, trial_end, access_granted, password_hash)
      VALUES (?, 'active', ?, 1, ?)
    `).run('existing@example.com', '2027-01-01T00:00:00.000Z', oldHash);

    const overwrite = await request(port, {
      method: 'POST',
      path: '/api/create-checkout',
      body: { email: 'existing@example.com', password: 'attacker-pass-99', billing: 'monthly' },
    });
    assert.strictEqual(overwrite.status, 200);
    const existing = db.prepare('SELECT password_hash FROM users WHERE email = ?').get('existing@example.com');
    assert.strictEqual(existing.password_hash, oldHash, 'checkout must not overwrite an existing password');
    const existingLogin = await request(port, {
      method: 'POST',
      path: '/api/login',
      body: { email: 'existing@example.com', password: 'original-pass-9' },
    });
    assert.strictEqual(existingLogin.status, 200, 'existing buyer still logs in with the original password');
    assert.ok(existingLogin.json && existingLogin.json.token);
    const existingAttack = await request(port, {
      method: 'POST',
      path: '/api/login',
      body: { email: 'existing@example.com', password: 'attacker-pass-99' },
    });
    assert.strictEqual(existingAttack.status, 401);
    await activateWhopMembership({
      status: 'active',
      id: 'mem_existing',
      email: 'existing@example.com',
    }, 'test', { sendLoginEmail: false });
    const existingAfterPay = db.prepare('SELECT password_hash, access_granted FROM users WHERE email = ?').get('existing@example.com');
    assert.strictEqual(existingAfterPay.password_hash, oldHash, 'payment must not clear a password on an account that already has access');
    assert.strictEqual(existingAfterPay.access_granted, 1);

    const attackCheckout = await request(port, {
      method: 'POST',
      path: '/api/create-checkout',
      body: { email: 'victim@example.com', password: 'attacker-pass-99', billing: 'monthly' },
    });
    assert.strictEqual(attackCheckout.status, 200);
    assert.ok(attackCheckout.json && attackCheckout.json.url, 'checkout still returns a payment URL');
    const pending = db.prepare('SELECT id, email, password_hash, access_granted, status FROM users WHERE email = ?').get('victim@example.com');
    assert.ok(pending, 'checkout still records the email');
    assert.strictEqual(pending.password_hash, null, 'checkout password is not stored');
    assert.strictEqual(pending.access_granted, 0);
    assert.strictEqual(pending.status, 'pending');

    const earlyJwt = jwt.sign(
      { email: pending.email, id: pending.id },
      process.env.JWT_SECRET,
      { expiresIn: '1h' }
    );
    const earlySet = await request(port, {
      method: 'POST',
      path: '/api/set-password',
      headers: { Authorization: 'Bearer ' + earlyJwt },
      body: { password: 'attacker-pass-99' },
    });
    assert.strictEqual(earlySet.status, 403, 'a pending checkout cannot set a password');
    const stillBlank = db.prepare('SELECT password_hash FROM users WHERE email = ?').get('victim@example.com');
    assert.strictEqual(stillBlank.password_hash, null);

    await activateWhopMembership({
      status: 'trialing',
      id: 'mem_victim',
      email: 'victim@example.com',
    }, 'test', { sendLoginEmail: false });
    const paid = db.prepare('SELECT password_hash, access_granted, status FROM users WHERE email = ?').get('victim@example.com');
    assert.strictEqual(paid.access_granted, 1, 'payment grants access');
    assert.strictEqual(paid.password_hash, null, 'payment does not attach the checkout password');

    const attackerLogin = await request(port, {
      method: 'POST',
      path: '/api/login',
      body: { email: 'victim@example.com', password: 'attacker-pass-99' },
    });
    assert.notStrictEqual(attackerLogin.status, 200);
    assert.ok(!attackerLogin.json || !attackerLogin.json.token, 'attacker cannot log in after the victim pays');
    assert.strictEqual(attackerLogin.status, 400);

    const priorHash = await bcrypt.hash('already-stored-pass', 10);
    db.prepare(`
      INSERT INTO users (email, status, access_granted, password_hash)
      VALUES (?, 'pending', 0, ?)
    `).run('prior@example.com', priorHash);
    await activateWhopMembership({
      status: 'trialing',
      id: 'mem_prior',
      email: 'prior@example.com',
    }, 'test', { sendLoginEmail: false });
    const prior = db.prepare('SELECT password_hash, access_granted FROM users WHERE email = ?').get('prior@example.com');
    assert.strictEqual(prior.access_granted, 1, 'payment still grants access on an older pending row');
    assert.strictEqual(prior.password_hash, null, 'a password stored before proof is cleared when payment lands');
    const priorLogin = await request(port, {
      method: 'POST',
      path: '/api/login',
      body: { email: 'prior@example.com', password: 'already-stored-pass' },
    });
    assert.notStrictEqual(priorLogin.status, 200);
    assert.ok(!priorLogin.json || !priorLogin.json.token);

    const buyerCheckout = await request(port, {
      method: 'POST',
      path: '/api/create-checkout',
      body: { email: 'buyer@example.com', billing: 'monthly' },
    });
    assert.strictEqual(buyerCheckout.status, 200, 'checkout works with no password');
    assert.ok(buyerCheckout.json.url);
    await activateWhopMembership({
      status: 'trialing',
      id: 'mem_buyer',
      email: 'buyer@example.com',
    }, 'test');
    const checkoutLogin = await request(port, {
      method: 'POST',
      path: '/api/login',
      body: { email: 'buyer@example.com', password: 'buyer-checkout-pass' },
    });
    assert.notStrictEqual(checkoutLogin.status, 200, 'a password that was never stored cannot log in');

    const magic = db.prepare('SELECT token FROM magic_tokens WHERE email = ?').get('buyer@example.com');
    assert.ok(magic && magic.token, 'payment emails a login link');
    const verified = await request(port, {
      method: 'GET',
      path: '/api/verify-magic?token=' + encodeURIComponent(magic.token),
    });
    assert.strictEqual(verified.status, 200, 'buyer opens the login link');
    assert.ok(verified.json && verified.json.token);
    assert.ok(verified.json.setPasswordToken, 'the login link also mints a set-password token');
    const purposeClaims = jwt.decode(verified.json.setPasswordToken);
    assert.strictEqual(purposeClaims.purpose, 'set-password');
    assert.strictEqual(purposeClaims.email, 'buyer@example.com');
    assert.ok(purposeClaims.exp - purposeClaims.iat <= 15 * 60, 'the set-password token expires within 15 minutes');
    assert.ok(purposeClaims.exp - purposeClaims.iat >= 60);
    const sessionClaims = jwt.decode(verified.json.token);
    assert.ok(!sessionClaims.purpose, 'the session token is not a set-password token');
    assert.strictEqual(sessionClaims.tv, 0);

    const buyerId = db.prepare('SELECT id FROM users WHERE email = ?').get('buyer@example.com').id;
    const expiredPurpose = jwt.sign(
      { email: 'buyer@example.com', id: buyerId, tv: 0, purpose: 'set-password', exp: Math.floor(Date.now() / 1000) - 30 },
      process.env.JWT_SECRET
    );
    const expiredSet = await request(port, {
      method: 'POST',
      path: '/api/set-password',
      headers: { Authorization: 'Bearer ' + expiredPurpose },
      body: { password: 'buyer-chosen-pass' },
    });
    assert.strictEqual(expiredSet.status, 401, 'an expired set-password token is refused');

    const anonSet = await request(port, {
      method: 'POST',
      path: '/api/set-password',
      body: { password: 'buyer-chosen-pass' },
    });
    assert.strictEqual(anonSet.status, 401);

    const sessionSet = await request(port, {
      method: 'POST',
      path: '/api/set-password',
      headers: { Authorization: 'Bearer ' + verified.json.token },
      body: { password: 'buyer-chosen-pass', email: 'victim@example.com' },
    });
    assert.strictEqual(sessionSet.status, 401, 'a normal login token cannot set the first password');
    const beforeSet = db.prepare('SELECT password_hash FROM users WHERE email = ?').get('buyer@example.com');
    assert.strictEqual(beforeSet.password_hash, null);

    const setPassword = await request(port, {
      method: 'POST',
      path: '/api/set-password',
      headers: { Authorization: 'Bearer ' + verified.json.setPasswordToken },
      body: { password: 'buyer-chosen-pass', email: 'victim@example.com' },
    });
    assert.strictEqual(setPassword.status, 200);
    assert.strictEqual(setPassword.json && setPassword.json.success, true);
    assert.ok(setPassword.json.token, 'set-password returns a fresh session token');
    const buyerAfterSet = db.prepare('SELECT password_hash, token_version FROM users WHERE email = ?').get('buyer@example.com');
    assert.ok(buyerAfterSet.password_hash, 'the password is stored on the token account');
    assert.strictEqual(buyerAfterSet.token_version, 1, 'setting a password bumps the token version');
    const victimAfter = db.prepare('SELECT password_hash FROM users WHERE email = ?').get('victim@example.com');
    assert.strictEqual(victimAfter.password_hash, null, 'an email in the body does not write another account');

    const staleMe = await request(port, {
      method: 'GET',
      path: '/api/me',
      headers: { Authorization: 'Bearer ' + verified.json.token },
    });
    assert.strictEqual(staleMe.status, 401, 'the login token from before the password change is dead');
    const purposeMe = await request(port, {
      method: 'GET',
      path: '/api/me',
      headers: { Authorization: 'Bearer ' + verified.json.setPasswordToken },
    });
    assert.strictEqual(purposeMe.status, 401, 'a set-password token is not a session');
    const freshMe = await request(port, {
      method: 'GET',
      path: '/api/me',
      headers: { Authorization: 'Bearer ' + setPassword.json.token },
    });
    assert.strictEqual(freshMe.status, 200, 'the fresh session token still works');
    assert.strictEqual(freshMe.json && freshMe.json.email, 'buyer@example.com');
    assert.strictEqual(freshMe.json && freshMe.json.has_password, true);

    const buyerLogin = await request(port, {
      method: 'POST',
      path: '/api/login',
      body: { email: 'buyer@example.com', password: 'buyer-chosen-pass' },
    });
    assert.strictEqual(buyerLogin.status, 200, 'buyer logs in with the password set after the email link');
    assert.ok(buyerLogin.json && buyerLogin.json.token);

    const shortPw = await request(port, {
      method: 'POST',
      path: '/api/set-password',
      headers: { Authorization: 'Bearer ' + buyerLogin.json.token },
      body: { password: 'short', currentPassword: 'buyer-chosen-pass' },
    });
    assert.strictEqual(shortPw.status, 400);

    const changed = await request(port, {
      method: 'POST',
      path: '/api/set-password',
      headers: { Authorization: 'Bearer ' + buyerLogin.json.token },
      body: { password: 'buyer-changed-pass', currentPassword: 'buyer-chosen-pass', email: 'victim@example.com' },
    });
    assert.strictEqual(changed.status, 200, 'the current password lets a login token change it');
    const oldLoginMe = await request(port, {
      method: 'GET',
      path: '/api/me',
      headers: { Authorization: 'Bearer ' + buyerLogin.json.token },
    });
    assert.strictEqual(oldLoginMe.status, 401, 'the previous login token dies when the password changes');
    const changedLogin = await request(port, {
      method: 'POST',
      path: '/api/login',
      body: { email: 'buyer@example.com', password: 'buyer-changed-pass' },
    });
    assert.strictEqual(changedLogin.status, 200);
    const victimStill = db.prepare('SELECT password_hash FROM users WHERE email = ?').get('victim@example.com');
    assert.strictEqual(victimStill.password_hash, null, 'a password change ignores the email in the body');

    const cancelledHash = await bcrypt.hash('cancelled-pass-9', 10);
    db.prepare(`
      INSERT INTO users (email, status, access_granted, password_hash, trial_end)
      VALUES (?, 'active', 1, ?, ?)
    `).run('cancelled@example.com', cancelledHash, '2027-01-01T00:00:00.000Z');
    await activateWhopMembership({
      status: 'canceled',
      id: 'mem_cancelled_off',
      email: 'cancelled@example.com',
    }, 'test', { sendLoginEmail: false });
    const cancelledOff = db.prepare('SELECT password_hash, access_granted, status FROM users WHERE email = ?').get('cancelled@example.com');
    assert.strictEqual(cancelledOff.password_hash, cancelledHash, 'cancelling does not clear a proven password');
    assert.strictEqual(cancelledOff.access_granted, 0);
    await activateWhopMembership({
      status: 'active',
      id: 'mem_cancelled_on',
      email: 'cancelled@example.com',
    }, 'test', { sendLoginEmail: false });
    const cancelledOn = db.prepare('SELECT password_hash, access_granted FROM users WHERE email = ?').get('cancelled@example.com');
    assert.strictEqual(cancelledOn.password_hash, cancelledHash, 'buying again keeps the cancelled account password');
    assert.strictEqual(cancelledOn.access_granted, 1);
    const cancelledLogin = await request(port, {
      method: 'POST',
      path: '/api/login',
      body: { email: 'cancelled@example.com', password: 'cancelled-pass-9' },
    });
    assert.strictEqual(cancelledLogin.status, 200, 'the cancelled buyer logs in with the same password');

    const revokedHash = await bcrypt.hash('revoked-pass-99', 10);
    db.prepare(`
      INSERT INTO users (email, status, access_granted, password_hash, trial_end)
      VALUES (?, 'active', 0, ?, ?)
    `).run('revoked@example.com', revokedHash, '2027-01-01T00:00:00.000Z');
    await activateWhopMembership({
      status: 'active',
      id: 'mem_revoked',
      email: 'revoked@example.com',
    }, 'test', { sendLoginEmail: false });
    const revoked = db.prepare('SELECT password_hash, access_granted, status FROM users WHERE email = ?').get('revoked@example.com');
    assert.strictEqual(revoked.password_hash, revokedHash, 'reactivating a revoked account keeps the password');
    assert.strictEqual(revoked.access_granted, 1);
    const revokedLogin = await request(port, {
      method: 'POST',
      path: '/api/login',
      body: { email: 'revoked@example.com', password: 'revoked-pass-99' },
    });
    assert.strictEqual(revokedLogin.status, 200, 'the revoked buyer logs in with the same password after reactivation');

    console.log('lib/checkout-preclaim.test.js passed');
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
