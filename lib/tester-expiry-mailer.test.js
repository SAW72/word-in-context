'use strict';
/**
 * The go paid email through a stub Resend client (real server.js, real SQLite).
 * Resend reports API errors as { error } and can also throw or reject. Every failure must
 * leave the 403 as is, release the claim so a later request retries, and never crash the
 * process with an unhandled rejection. A good send later goes out exactly once.
 */
const assert = require('assert');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const jwt = require('jsonwebtoken');
const { Resend } = require('resend');

const dbFile = path.join(os.tmpdir(), `wic-tester14-mailer-${process.pid}.db`);
const cleanDb = () => { for (const f of [dbFile, dbFile + '-wal', dbFile + '-shm']) { try { fs.unlinkSync(f); } catch (e) {} } };
cleanDb();

// Stub every Resend client: no network, behavior chosen per step.
let mode = 'ok';
const sends = [];
Object.getPrototypeOf(new Resend('re_stub_probe_only').emails).send = function (msg) {
  sends.push({ to: msg.to, subject: msg.subject, html: msg.html, mode });
  if (mode === 'throw') throw new Error('stub resend throw');
  if (mode === 'reject') return Promise.reject(new Error('stub resend reject'));
  if (mode === 'error') return Promise.resolve({ data: null, error: { name: 'validation_error', message: 'stub error result' } });
  return Promise.resolve({ data: { id: 'em_stub' }, error: null });
};
const unhandled = [];
process.on('unhandledRejection', (reason) => { unhandled.push(String((reason && reason.message) || reason)); });

process.env.NODE_ENV = 'test';
process.env.WIC_DB_PATH = dbFile;
process.env.JWT_SECRET = 'unit-test-jwt-secret-at-least-32-chars';
process.env.ADMIN_PASSWORD = 'unit-test-admin-password';
process.env.XAI_API_KEY = '';
process.env.RESEND_API_KEY = 're_stub_unit_only_not_a_real_key';
process.env.STRIPE_SECRET_KEY = '';
process.env.TESTER_TRIAL_DAYS = '14';

const { app, db } = require('../server');

const errors = [];
const origError = console.error;
console.error = (...args) => { errors.push(args.map((a) => (a && a.message) || String(a)).join(' ')); };

const SUBJECT = 'Your tester access to The Word in Context has ended';
const settle = () => new Promise((r) => setTimeout(r, 30));

function get(port, urlPath, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port, method: 'GET', path: urlPath, headers }, (res) => {
      let raw = '';
      res.on('data', (c) => { raw += c; });
      res.on('end', () => resolve({ status: res.statusCode, raw }));
    });
    req.on('error', reject);
    req.end();
  });
}

async function main() {
  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  try {
    const email = 'stub.tester@example.com';
    const id = db.prepare("INSERT INTO users (email, status, trial_end, access_granted) VALUES (?, 'trialing', '2020-01-01T00:00:00.000Z', 1)").run(email).lastInsertRowid;
    const auth = { Authorization: 'Bearer ' + jwt.sign({ email }, process.env.JWT_SECRET, { expiresIn: '1h' }) };
    const marker = () => db.prepare('SELECT tester_expired_email_at FROM users WHERE id = ?').get(id).tester_expired_email_at;

    for (const m of ['error', 'throw', 'reject']) {
      mode = m;
      const before = sends.length;
      errors.length = 0;
      const r = await get(port, '/api/me', auth);
      await settle();
      assert.strictEqual(r.status, 403, `${m}: still cut off`);
      assert.strictEqual(JSON.parse(r.raw).code, 'tester_expired', `${m}: the tester still sees the ended state`);
      assert.strictEqual(sends.length, before + 1, `${m}: one send attempt`);
      assert.strictEqual(marker(), null, `${m}: claim released so a later request retries`);
      assert.ok(errors.some((l) => l.includes(`go paid email failed for user ${id}`)), `${m}: failure logged by user id`);
      assert.deepStrictEqual(unhandled, [], `${m}: no unhandled rejection`);
      assert.strictEqual((await get(port, '/api/config')).status, 200, `${m}: process still serving`);
    }

    // Mailer back: exactly one email, then never again.
    mode = 'ok';
    const before = sends.length;
    await Promise.all(Array.from({ length: 10 }, () => get(port, '/api/me', auth)));
    await settle();
    await get(port, '/api/me', auth);
    await settle();
    assert.strictEqual(sends.length, before + 1, 'one good send after the failures');
    const last = sends[sends.length - 1];
    assert.strictEqual(last.to, email);
    assert.strictEqual(last.subject, SUBJECT);
    assert.ok(last.html.includes('/#signup"'), 'email links to the paid signup');
    assert.ok(marker(), 'marker kept after the good send');
    mode = 'throw';
    await get(port, '/api/me', auth);
    await settle();
    assert.strictEqual(sends.length, before + 1, 'no send attempt once the email went out');
    assert.deepStrictEqual(unhandled, [], 'no unhandled rejection at all');

    console.error = origError;
    console.log('lib/tester-expiry-mailer.test.js passed');
  } finally {
    console.error = origError;
    await new Promise((r) => server.close(r));
    try { db.close(); } catch (e) {}
    cleanDb();
  }
}

main().catch((err) => {
  console.error = origError;
  console.error(err);
  process.exit(1);
});
