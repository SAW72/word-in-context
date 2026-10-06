'use strict';
/**
 * Service worker cache version, login/checkout email lookup, and webhook email checks.
 */
const assert = require('assert');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const vm = require('vm');

const dbFile = path.join(os.tmpdir(), `wic-cache-email-${process.pid}.db`);
for (const extra of [dbFile, dbFile + '-wal', dbFile + '-shm']) {
  try { fs.unlinkSync(extra); } catch (e) {}
}

process.env.NODE_ENV = 'test';
process.env.WIC_DB_PATH = dbFile;
process.env.JWT_SECRET = 'unit-test-jwt-secret-at-least-32-chars';
process.env.ADMIN_PASSWORD = 'unit-test-admin-password';
process.env.RESEND_API_KEY = '';
process.env.WHOP_CHECKOUT_URL = 'https://whop.com/checkout/test-plan';
process.env.STRIPE_SECRET_KEY = '';
process.env.STRIPE_PRICE_ID = '';

const { app, db, activateWhopMembership, activateStripeCheckoutSession } = require('../server');

const LOGIN_MISSING = 'No account with that email. Use the trial form on the landing or the tester signup (no card) below.';
const CHECKOUT_MISSING = 'No account found for that email. Use the trial form first, then complete Whop checkout with the same email.';
const BAD_EMAIL = 'pastor<img src=x>@church.org';

function listen() {
  return new Promise((resolve) => {
    const server = http.createServer(app);
    server.listen(0, '127.0.0.1', () => {
      resolve({ server, port: server.address().port });
    });
  });
}

function request(port, { method, path: urlPath, body }) {
  return new Promise((resolve, reject) => {
    const payload = body == null ? null : Buffer.from(JSON.stringify(body));
    const req = http.request({
      hostname: '127.0.0.1',
      port,
      method: method || 'GET',
      path: urlPath,
      headers: payload
        ? { 'Content-Type': 'application/json', 'Content-Length': payload.length }
        : {},
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

function withWarn(fn) {
  const warnings = [];
  const orig = console.warn;
  console.warn = (...args) => {
    warnings.push(args.map((part) => String(part)).join(' '));
  };
  return Promise.resolve()
    .then(fn)
    .then((value) => ({ value, warnings }))
    .finally(() => {
      console.warn = orig;
    });
}

function assertCacheVersion() {
  const sw = fs.readFileSync(path.join(__dirname, '..', 'public', 'sw.js'), 'utf8');
  const activateStart = sw.indexOf("self.addEventListener('activate'");
  const activateEnd = sw.indexOf('async function bibleResponse');
  assert.ok(activateStart >= 0 && activateEnd > activateStart, 'activate handler is present');
  const activate = sw.slice(activateStart, activateEnd);
  assert.ok(activate.includes('!k.startsWith(CACHE_VERSION)'), 'activate drops caches from older workers');
  assert.ok(activate.includes('caches.delete'), 'activate deletes the older cache keys');

  const versionEnd = sw.indexOf('const BIBLE_ORIGIN');
  const prelude = sw.slice(0, versionEnd);
  const keys = [
    'wic-pwa-68-shell',
    'wic-pwa-68-bible',
    'wic-pwa-69-shell',
    'wic-pwa-69-bible',
  ];
  const dropped = vm.runInNewContext(
    prelude + '\nkeys.filter((k) => !k.startsWith(CACHE_VERSION));',
    { keys }
  );
  assert.deepStrictEqual(dropped, ['wic-pwa-68-shell', 'wic-pwa-68-bible']);
  assert.ok(dropped.includes('wic-pwa-68-shell'), 'activate clears the previous shell cache');
  assert.strictEqual(sw.includes("CACHE_VERSION = 'wic-pwa-69'"), true);
}

async function main() {
  assertCacheVersion();

  const { server, port } = await listen();
  try {
    const emptyLogin = await request(port, {
      method: 'POST',
      path: '/api/request-login',
      body: { email: '   ' },
    });
    assert.strictEqual(emptyLogin.status, 400);
    assert.deepStrictEqual(emptyLogin.json, { error: 'Email required' });

    const missingLogin = await request(port, {
      method: 'POST',
      path: '/api/request-login',
      body: { email: BAD_EMAIL },
    });
    assert.strictEqual(missingLogin.status, 404);
    assert.deepStrictEqual(missingLogin.json, { error: LOGIN_MISSING });

    db.prepare(`
      INSERT INTO users (email, status, access_granted)
      VALUES (?, 'active', 1)
    `).run(BAD_EMAIL);
    const existingLogin = await request(port, {
      method: 'POST',
      path: '/api/request-login',
      body: { email: BAD_EMAIL },
    });
    assert.strictEqual(existingLogin.status, 200);
    assert.deepStrictEqual(existingLogin.json, {
      success: true,
      message: 'Check your email for a login link.',
    });

    const emptyCheckout = await request(port, {
      method: 'POST',
      path: '/api/complete-checkout',
      body: { email: '' },
    });
    assert.strictEqual(emptyCheckout.status, 400);
    assert.deepStrictEqual(emptyCheckout.json, { error: 'email required' });

    const spacedCheckout = await request(port, {
      method: 'POST',
      path: '/api/complete-checkout',
      body: { email: 'not an email' },
    });
    assert.strictEqual(spacedCheckout.status, 404);
    assert.deepStrictEqual(spacedCheckout.json, { error: CHECKOUT_MISSING });

    db.prepare(`
      INSERT INTO users (email, status, access_granted)
      VALUES (?, 'trialing', 1)
    `).run('not an email');
    const existingCheckout = await request(port, {
      method: 'POST',
      path: '/api/complete-checkout',
      body: { email: 'Not An Email' },
    });
    assert.strictEqual(existingCheckout.status, 200);
    assert.deepStrictEqual(existingCheckout.json, {
      success: true,
      email: 'not an email',
      message: 'Trial active. Check your email for a secure login link, or use the Log in button with the password you chose.',
    });

    const skippedWhop = await withWarn(() => activateWhopMembership({
      id: 'mem_bad',
      status: 'active',
      user: { email: 'new<img src=x>@example.com' },
    }, 'webhook'));
    assert.strictEqual(skippedWhop.value, null);
    assert.strictEqual(
      db.prepare('SELECT id FROM users WHERE email = ?').get('new<img src=x>@example.com'),
      undefined
    );
    assert.ok(
      skippedWhop.warnings.some((line) => line.includes('email failed the account email check')),
      'whop skip is logged'
    );

    const created = await activateWhopMembership({
      id: 'mem_ok',
      status: 'active',
      user: { email: 'new.member@example.com' },
    }, 'webhook', { sendLoginEmail: false });
    assert.ok(created);
    assert.strictEqual(created.email, 'new.member@example.com');
    assert.ok(db.prepare('SELECT id FROM users WHERE email = ?').get('new.member@example.com'));

    db.prepare(`
      INSERT INTO users (email, status, access_granted)
      VALUES (?, 'canceled', 0)
    `).run('stripe<img src=x>@example.com');
    const skippedStripe = await withWarn(() => activateStripeCheckoutSession({
      id: 'cs_bad',
      metadata: { email: 'stripe<img src=x>@example.com' },
      customer_email: 'stripe<img src=x>@example.com',
    }, 'webhook'));
    assert.strictEqual(skippedStripe.value, null);
    const unchanged = db.prepare('SELECT status, access_granted FROM users WHERE email = ?').get('stripe<img src=x>@example.com');
    assert.strictEqual(unchanged.status, 'canceled');
    assert.strictEqual(unchanged.access_granted, 0);
    assert.ok(
      skippedStripe.warnings.some((line) => line.includes('email failed the account email check')),
      'stripe skip is logged'
    );

    db.prepare(`
      INSERT INTO users (email, status, access_granted)
      VALUES (?, 'canceled', 0)
    `).run('stripe.member@example.com');
    const updated = await activateStripeCheckoutSession({
      id: 'cs_ok',
      metadata: { email: 'stripe.member@example.com' },
    }, 'webhook');
    assert.ok(updated);
    assert.strictEqual(updated.status, 'trialing');
    assert.strictEqual(updated.access_granted, 1);

    console.log('lib/cache-email-lookup.test.js passed');
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
