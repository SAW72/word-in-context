'use strict';
/**
 * set-password is limited per account and per IP.
 * One account hitting the cap does not block a different account on the same IP
 * until the IP cap is hit too.
 */
const assert = require('assert');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const jwt = require('jsonwebtoken');

const dbFile = path.join(os.tmpdir(), `wic-set-password-${process.pid}.db`);
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
process.env.SET_PASSWORD_ACCOUNT_MAX = '2';
process.env.SET_PASSWORD_IP_MAX = '4';

const { app, db } = require('../server');

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
    const payload = body == null ? null : Buffer.from(JSON.stringify(body));
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

function purposeToken(user) {
  return jwt.sign(
    { email: user.email, id: user.id, tv: Number(user.token_version) || 0, purpose: 'set-password' },
    process.env.JWT_SECRET,
    { expiresIn: '15m' }
  );
}

async function main() {
  const { server, port } = await listen();
  try {
    db.prepare(`
      INSERT INTO users (email, status, access_granted, token_version)
      VALUES ('limit-a@example.com', 'active', 1, 0),
             ('limit-b@example.com', 'active', 1, 0)
    `).run();
    const userA = db.prepare('SELECT * FROM users WHERE email = ?').get('limit-a@example.com');
    const userB = db.prepare('SELECT * FROM users WHERE email = ?').get('limit-b@example.com');
    const tokenA = purposeToken(userA);
    const tokenB = purposeToken(userB);

    async function setPassword(token, password) {
      return request(port, {
        method: 'POST',
        path: '/api/set-password',
        headers: { Authorization: 'Bearer ' + token },
        body: { password, email: 'limit-b@example.com' },
      });
    }

    const first = await setPassword(tokenA, 'account-a-pass-1');
    assert.strictEqual(first.status, 200, 'first set-password for account A');
    const second = await setPassword(tokenA, 'account-a-pass-2');
    assert.strictEqual(second.status, 401, 'the same purpose token dies after the version bump');
    const third = await setPassword(tokenA, 'account-a-pass-3');
    assert.strictEqual(third.status, 429, 'account A is limited');
    assert.ok(third.json && third.json.error.includes('this account'), third.json && third.json.error);

    const other = await setPassword(tokenB, 'account-b-pass-1');
    assert.strictEqual(other.status, 200, 'account B is not blocked by account A');
    const hashedA = db.prepare('SELECT password_hash FROM users WHERE email = ?').get('limit-a@example.com');
    const hashedB = db.prepare('SELECT password_hash FROM users WHERE email = ?').get('limit-b@example.com');
    assert.ok(hashedA.password_hash);
    assert.ok(hashedB.password_hash);
    assert.notStrictEqual(hashedA.password_hash, hashedB.password_hash, 'the body email did not point both writes at B');

    const network = await setPassword(tokenB, 'account-b-pass-2');
    assert.strictEqual(network.status, 429, 'the shared IP is limited');
    assert.ok(network.json && network.json.error.includes('this network'), network.json && network.json.error);

    console.log('lib/set-password.test.js passed');
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
