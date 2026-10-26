'use strict';
/**
 * The set password route: a signed in user sets a password for email and password login.
 * Behind requireAuth, so every user it cuts off (canceled, past_due, pending, revoked,
 * expired tester) gets exactly the same response as /api/me. When a password already exists
 * the current one is required, and wrong guesses lock the change per user id.
 * The password never appears in a response or a log line. HTTP level, real server.js.
 */
const assert = require('assert');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');

const dbFile = path.join(os.tmpdir(), `wic-set-password-${process.pid}.db`);
const cleanDb = () => { for (const f of [dbFile, dbFile + '-wal', dbFile + '-shm']) { try { fs.unlinkSync(f); } catch (e) {} } };
cleanDb();

process.env.NODE_ENV = 'test';
process.env.WIC_DB_PATH = dbFile;
process.env.JWT_SECRET = 'unit-test-jwt-secret-at-least-32-chars';
process.env.ADMIN_PASSWORD = 'unit-test-admin-password';
process.env.XAI_API_KEY = '';
process.env.RESEND_API_KEY = '';
process.env.STRIPE_SECRET_KEY = '';
process.env.TESTER_TRIAL_DAYS = '14';

const { app, db } = require('../server');

// Every console line, so the test can prove no password or email reaches the logs.
const lines = [];
const orig = { log: console.log, error: console.error, warn: console.warn };
for (const k of ['log', 'error', 'warn']) {
  console[k] = (...args) => { lines.push(args.map((a) => (a && a.stack) || (typeof a === 'string' ? a : JSON.stringify(a))).join(' ')); };
}
const restore = () => { Object.assign(console, orig); };

const PAST = '2020-01-01T00:00:00.000Z';
const FUTURE = new Date(Date.now() + 5 * 86400000).toISOString();
const OLD_PW = 'OldSecretPw1one';
const NEW_PW = 'NewSecretPw2two';
const FIRST_PW = 'FirstSecretPw3three';
const LOCK_PW = 'LockSecretPw4four';
const BLOCK_PW = 'BlockSecretPw5five';
const BURST_PW = 'BurstSecretPw6six';
const EIGHT_PW = 'Exactly8';
const ALICE_PW = 'AliceSecretPw7seven';
const BOB_PW = 'BobSecretPw8eight';
const PAD_PW = 'PadSecretPw9nine';
const PLAINS = [OLD_PW, NEW_PW, FIRST_PW, LOCK_PW, BLOCK_PW, BURST_PW, EIGHT_PW, ALICE_PW, BOB_PW, PAD_PW, 'Short7x', 'WrongGuess0', 'WrongGuess1', 'WrongGuess2', 'WrongGuess3', 'WrongGuess4', 'WrongGuess5'];
const responses = [];

function listen() {
  return new Promise((resolve) => {
    const server = http.createServer(app);
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}
function request(port, method, urlPath, { headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body == null ? null : Buffer.from(body);
    const req = http.request({ hostname: '127.0.0.1', port, method, path: urlPath, headers: { ...(payload ? { 'Content-Length': payload.length } : {}), ...headers } }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = JSON.parse(raw); } catch (e) {}
        responses.push(raw);
        resolve({ status: res.statusCode, raw, json, headers: res.headers });
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}
const row = (email) => db.prepare('SELECT * FROM users WHERE email = ?').get(email);
const tokenFor = (email, secret = process.env.JWT_SECRET) => {
  const r = row(email);
  return jwt.sign({ email, id: r ? r.id : undefined }, secret, { expiresIn: '1h' });
};
const auth = (email) => ({ Authorization: 'Bearer ' + tokenFor(email) });
const setPw = (port, email, body, headers) => request(port, 'POST', '/api/set-password', {
  headers: { 'Content-Type': 'application/json', ...(headers || (email ? auth(email) : {})) },
  body: body === undefined ? undefined : JSON.stringify(body),
});
const me = (port, email) => request(port, 'GET', '/api/me', { headers: auth(email) });
const login = (port, email, password) => request(port, 'POST', '/api/login', { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password }) });

function seed(email, { status = 'active', trialEnd = null, access = 1, manualFree = 0, password = null, membership = null } = {}) {
  db.prepare(`INSERT INTO users (email, status, trial_end, access_granted, manual_free, password_hash, whop_membership_id)
    VALUES (?, ?, ?, ?, ?, ?, ?)`).run(email, status, trialEnd, access, manualFree, password ? bcrypt.hashSync(password, 4) : null, membership);
}

async function main() {
  const { server, port } = await listen();
  try {
    // 1. No session: the same 401s requireAuth gives every route.
    const anon = await setPw(port, null, { password: FIRST_PW }, {});
    assert.strictEqual(anon.status, 401, `no token is 401 (got ${anon.status} ${anon.raw})`);
    assert.deepStrictEqual(anon.json, { error: 'Authentication required' }, 'no token body');
    seed('magic.user@example.com');
    const forged = await setPw(port, null, { password: FIRST_PW }, { Authorization: 'Bearer ' + tokenFor('magic.user@example.com', 'not-the-real-secret-at-all-32-chars') });
    assert.strictEqual(forged.status, 401, 'forged token is 401');
    assert.deepStrictEqual(forged.json, { error: 'Invalid or expired token' }, 'forged token body');
    const ghost = await setPw(port, null, { password: FIRST_PW }, { Authorization: 'Bearer ' + tokenFor('nobody@example.com') });
    assert.strictEqual(ghost.status, 401, 'unknown user is 401');
    assert.strictEqual(row('magic.user@example.com').password_hash, null, 'no password written by a rejected session');

    // 2. Clear 400s for a missing, empty, non string or short password. Nothing written.
    const u = 'magic.user@example.com';
    const meBefore = await me(port, u);
    assert.strictEqual(meBefore.json.has_password, false, 'magic link user starts with has_password false');
    for (const [label, body, msg] of [
      ['no body', undefined, 'Enter a new password.'],
      ['missing', {}, 'Enter a new password.'],
      ['empty', { password: '' }, 'Enter a new password.'],
      ['number', { password: 12345678 }, 'Enter a new password.'],
      ['array', { password: ['abcdefgh'] }, 'Enter a new password.'],
      ['seven chars', { password: 'Short7x' }, 'Password must be at least 8 characters.'],
    ]) {
      const r = await setPw(port, u, body);
      assert.strictEqual(r.status, 400, `${label}: 400 (got ${r.status} ${r.raw})`);
      assert.deepStrictEqual(r.json, { error: msg }, `${label}: clear message`);
    }
    assert.strictEqual(row(u).password_hash, null, 'no hash after the 400s');

    // 3. First password: no current password needed. Stored as bcrypt cost 10; login works.
    // A bystander row proves the write touches only the signed in user.
    seed('bystander@example.com', { password: OLD_PW });
    const hBy = row('bystander@example.com').password_hash;
    const first = await setPw(port, u, { password: FIRST_PW });
    assert.strictEqual(first.status, 200, `first password 200 (got ${first.status} ${first.raw})`);
    assert.strictEqual(first.json.success, true, 'first password success');
    const h1 = row(u).password_hash;
    assert.ok(/^\$2[aby]\$10\$/.test(h1), 'hash is bcrypt cost 10, same as hashPassword');
    assert.ok(bcrypt.compareSync(FIRST_PW, h1), 'stored hash matches the new password');
    const li = await login(port, u, FIRST_PW);
    assert.strictEqual(li.status, 200, `password login works after set (got ${li.status})`);
    assert.ok(li.json.token && li.json.email === u, 'login returns a token');
    assert.strictEqual((await me(port, u)).json.has_password, true, 'has_password true after set');
    assert.strictEqual(row('bystander@example.com').password_hash, hBy, 'bystander hash unchanged');

    // 4. A password exists: the current one is required and checked.
    const noCur = await setPw(port, u, { password: NEW_PW });
    assert.strictEqual(noCur.status, 400, 'change without current password is 400');
    assert.deepStrictEqual(noCur.json, { error: 'Enter your current password to change it.' }, 'missing current password message');
    const badCur = await setPw(port, u, { password: NEW_PW, current_password: 'WrongGuess0' });
    assert.strictEqual(badCur.status, 403, 'wrong current password is 403');
    assert.deepStrictEqual(badCur.json, { error: 'Current password is incorrect.' }, 'wrong current password message');
    assert.strictEqual(row(u).password_hash, h1, 'hash unchanged after a wrong current password');
    const shortNew = await setPw(port, u, { password: 'Short7x', current_password: FIRST_PW });
    assert.strictEqual(shortNew.status, 400, 'short new password still 400 with the right current one');
    const good = await setPw(port, u, { password: NEW_PW, current_password: FIRST_PW });
    assert.strictEqual(good.status, 200, `change with the right current password 200 (got ${good.status} ${good.raw})`);
    assert.strictEqual((await login(port, u, NEW_PW)).status, 200, 'new password logs in');
    assert.strictEqual((await login(port, u, FIRST_PW)).status, 401, 'old password no longer logs in');

    // 5. Lockout per user id: 5 wrong current passwords lock this account's change, not others.
    const lk = 'lock.user@example.com';
    seed(lk, { password: LOCK_PW });
    const hLk = row(lk).password_hash;
    for (let i = 1; i <= 4; i += 1) {
      const r = await setPw(port, lk, { password: NEW_PW, current_password: 'WrongGuess' + i });
      assert.strictEqual(r.status, 403, `wrong guess ${i} is 403`);
    }
    const fifth = await setPw(port, lk, { password: NEW_PW, current_password: 'WrongGuess5' });
    assert.strictEqual(fifth.status, 429, `fifth wrong guess locks (got ${fifth.status} ${fifth.raw})`);
    assert.strictEqual(fifth.json.error, 'Too many password attempts. Try again later.', 'lock message');
    assert.ok(Number(fifth.headers['retry-after']) > 0, 'Retry-After header on lock');
    const locked = await setPw(port, lk, { password: NEW_PW, current_password: LOCK_PW });
    assert.strictEqual(locked.status, 429, 'even the right current password waits out the lock');
    assert.strictEqual(row(lk).password_hash, hLk, 'locked account hash unchanged');
    assert.strictEqual((await login(port, lk, LOCK_PW)).status, 200, 'lock does not affect normal login');
    const other = await setPw(port, u, { password: FIRST_PW, current_password: NEW_PW });
    assert.strictEqual(other.status, 200, 'another user is not locked');
    // A success clears earlier misses: 4 wrong, 1 right, then 4 more wrong are still 403, not 429.
    const rs = 'reset.user@example.com';
    seed(rs, { password: OLD_PW });
    for (let i = 1; i <= 4; i += 1) await setPw(port, rs, { password: NEW_PW, current_password: 'WrongGuess' + i });
    assert.strictEqual((await setPw(port, rs, { password: NEW_PW, current_password: OLD_PW })).status, 200, 'right password before the limit saves');
    const after = [];
    for (let i = 1; i <= 4; i += 1) after.push((await setPw(port, rs, { password: OLD_PW, current_password: 'WrongGuess' + i })).status);
    assert.deepStrictEqual(after, [403, 403, 403, 403], 'misses start over after a success');
    assert.strictEqual(row('bystander@example.com').password_hash, hBy, 'bystander hash still unchanged');

    // 5b. A parallel burst sees the lock. bcrypt.compare is held open until every request is in,
    // so 11 wrong guesses and then the right one are all in flight at once. Each attempt is counted
    // before the compare, so only 5 compares run and the right guess, sent last, is refused.
    const bu = 'burst.user@example.com';
    seed(bu, { password: BURST_PW });
    const hBu = row(bu).password_hash;
    const waitFor = async (cond, label) => {
      const until = Date.now() + 5000;
      while (!cond()) {
        if (Date.now() > until) throw new Error(`timed out waiting for ${label}`);
        await new Promise((r) => setTimeout(r, 5));
      }
    };
    const realCompare = bcrypt.compare;
    let compares = 0;
    let release;
    const gate = new Promise((r) => { release = r; });
    bcrypt.compare = async (...args) => { compares += 1; await gate; return realCompare.apply(bcrypt, args); };
    const done = [];
    let burst;
    try {
      const wrong = [];
      for (let i = 0; i < 11; i += 1) {
        wrong.push(setPw(port, bu, { password: NEW_PW, current_password: 'WrongGuess' + (i % 6) }).then((r) => { done.push(r); return r; }));
      }
      await waitFor(() => compares + done.length === 11, 'the wrong guesses');
      const right = setPw(port, bu, { password: NEW_PW, current_password: BURST_PW }).then((r) => { done.push(r); return r; });
      await waitFor(() => compares + done.length === 12, 'the right guess');
      release();
      burst = await Promise.all([...wrong, right]);
    } finally {
      release();
      bcrypt.compare = realCompare;
    }
    const rightGuess = burst[11];
    assert.strictEqual(rightGuess.status, 429, `right guess sent after 11 parallel wrong guesses is 429 (got ${rightGuess.status} ${rightGuess.raw})`);
    assert.strictEqual(row(bu).password_hash, hBu, 'burst: hash unchanged');
    assert.strictEqual(compares, 5, `burst: only 5 compares run (got ${compares})`);
    const codes = burst.map((r) => r.status).sort();
    assert.deepStrictEqual(codes, [403, 403, 403, 403, 429, 429, 429, 429, 429, 429, 429, 429], 'burst: 4 wrong guesses are 403, the rest 429');
    for (const r of burst.filter((x) => x.status === 429)) {
      assert.strictEqual(r.headers['retry-after'], '900', 'burst: Retry-After 900 on every 429');
    }

    // 5c. An exactly 8 character password is accepted.
    const e8 = 'eight.user@example.com';
    seed(e8);
    assert.strictEqual(EIGHT_PW.length, 8, 'fixture is 8 characters');
    const eight = await setPw(port, e8, { password: EIGHT_PW });
    assert.strictEqual(eight.status, 200, `8 character password 200 (got ${eight.status} ${eight.raw})`);
    assert.ok(bcrypt.compareSync(EIGHT_PW, row(e8).password_hash), '8 character password stored');
    assert.strictEqual((await login(port, e8, EIGHT_PW)).status, 200, '8 character password logs in');

    // 5d. Lock and window edges with Date.now stubbed. The lock lasts exactly 15 minutes with
    // Retry-After 900, and a failure counts toward the lock for exactly 15 minutes.
    const MIN15 = 15 * 60 * 1000;
    const realNow = Date.now;
    let clock = realNow();
    Date.now = () => clock;
    try {
      const wrongAt = (email, n) => setPw(port, email, { password: NEW_PW, current_password: 'WrongGuess' + n });
      const le = 'lock.edge@example.com';
      seed(le, { password: LOCK_PW });
      const hLe = row(le).password_hash;
      for (let i = 1; i <= 4; i += 1) assert.strictEqual((await wrongAt(le, i)).status, 403, `lock edge: wrong guess ${i} is 403`);
      const t0 = clock;
      const lockNow = await wrongAt(le, 5);
      assert.strictEqual(lockNow.status, 429, 'lock edge: fifth wrong guess locks');
      assert.strictEqual(lockNow.headers['retry-after'], '900', 'lock edge: Retry-After 900 when the lock starts');
      assert.strictEqual(lockNow.json.retryAfterSec, 900, 'lock edge: retryAfterSec 900');
      clock = t0 + 1000;
      const oneSec = await wrongAt(le, 1);
      assert.strictEqual(oneSec.status, 429, 'lock edge: still locked after 1 second');
      assert.strictEqual(oneSec.headers['retry-after'], '899', 'lock edge: Retry-After counts down');
      clock = t0 + MIN15;
      clock -= 1;
      const lastMs = await setPw(port, le, { password: NEW_PW, current_password: LOCK_PW });
      assert.strictEqual(lastMs.status, 429, 'lock edge: right password 1 ms before the lock ends is 429');
      assert.strictEqual(lastMs.headers['retry-after'], '1', 'lock edge: Retry-After 1 in the last ms');
      assert.strictEqual(row(le).password_hash, hLe, 'lock edge: hash unchanged while locked');
      clock = t0 + MIN15;
      assert.strictEqual((await wrongAt(le, 2)).status, 403, 'lock edge: lock is over at exactly 15 minutes');
      const unlocked = await setPw(port, le, { password: NEW_PW, current_password: LOCK_PW });
      assert.strictEqual(unlocked.status, 200, `lock edge: right password saves after the lock (got ${unlocked.status} ${unlocked.raw})`);

      const wIn = 'window.inside@example.com';
      seed(wIn, { password: LOCK_PW });
      const w0 = clock;
      assert.strictEqual((await wrongAt(wIn, 1)).status, 403, 'window: first failure');
      clock = w0 + MIN15;
      clock -= 1;
      for (let i = 2; i <= 4; i += 1) assert.strictEqual((await wrongAt(wIn, i)).status, 403, `window: failure ${i} is 403`);
      const inside = await wrongAt(wIn, 5);
      assert.strictEqual(inside.status, 429, 'window: 5 failures within 15 minutes less 1 ms lock');
      assert.strictEqual(inside.headers['retry-after'], '900', 'window: Retry-After 900');

      const wOut = 'window.outside@example.com';
      seed(wOut, { password: LOCK_PW });
      const w1 = clock;
      assert.strictEqual((await wrongAt(wOut, 1)).status, 403, 'window: first failure');
      clock = w1 + MIN15;
      for (let i = 2; i <= 5; i += 1) {
        const r = await wrongAt(wOut, i);
        assert.strictEqual(r.status, 403, `window: failure ${i} at exactly 15 minutes is 403, the first one has expired`);
        assert.strictEqual(r.headers['retry-after'], undefined, 'window: no Retry-After on a 403');
      }
      assert.strictEqual((await wrongAt(wOut, 6)).status, 429, 'window: the fifth failure inside the window locks');
    } finally {
      Date.now = realNow;
    }

    // 5e. User A posting user B's email and id changes only A. B's hash is unchanged.
    const ua = 'alice.user@example.com';
    const ub = 'bob.user@example.com';
    seed(ua, { password: ALICE_PW });
    seed(ub, { password: BOB_PW });
    const hB = row(ub).password_hash;
    const bId = row(ub).id;
    const cross = await setPw(port, ua, { password: NEW_PW, current_password: ALICE_PW, email: ub, id: bId, user_id: bId });
    assert.strictEqual(cross.status, 200, `A changing her own password 200 (got ${cross.status} ${cross.raw})`);
    assert.strictEqual(row(ub).password_hash, hB, "B's hash unchanged when A posts B's email and id");
    assert.ok(bcrypt.compareSync(NEW_PW, row(ua).password_hash), "A's hash is the new password");
    assert.strictEqual((await login(port, ub, BOB_PW)).status, 200, 'B still logs in with his own password');

    // 5f. A padded current password is wrong: no trimming, 403, hash unchanged.
    const pu = 'pad.user@example.com';
    seed(pu, { password: PAD_PW });
    const hPu = row(pu).password_hash;
    for (const padded of [` ${PAD_PW}`, `${PAD_PW} `, ` ${PAD_PW} `]) {
      const r = await setPw(port, pu, { password: NEW_PW, current_password: padded });
      assert.strictEqual(r.status, 403, `padded current password is 403 (got ${r.status} ${r.raw})`);
      assert.deepStrictEqual(r.json, { error: 'Current password is incorrect.' }, 'padded current password message');
    }
    assert.strictEqual(row(pu).password_hash, hPu, 'padded current password: hash unchanged');

    // 6. Cut off users are blocked exactly as requireAuth blocks /api/me, and nothing is written.
    const blocked = [
      ['canceled', { status: 'canceled' }],
      ['past_due', { status: 'past_due' }],
      ['pending', { status: 'pending' }],
      ['revoked', { status: 'active', access: 0 }],
      ['revoked tester', { status: 'trialing', trialEnd: FUTURE, access: 0 }],
      ['expired whop trial canceled', { status: 'canceled', trialEnd: PAST, membership: 'mem_unit_1' }],
      ['expired tester', { status: 'trialing', trialEnd: PAST }],
    ];
    for (const [label, opts] of blocked) {
      for (const pw of [null, BLOCK_PW]) {
        const email = `blocked.${label.replace(/ /g, '.')}.${pw ? 'pw' : 'nopw'}@example.com`;
        seed(email, { ...opts, password: pw });
        const before = row(email).password_hash;
        const ref = await me(port, email);
        const r = await setPw(port, email, { password: NEW_PW, current_password: pw || undefined });
        assert.strictEqual(r.status, ref.status, `${label} ${pw ? 'with' : 'without'} password: same status as /api/me (${ref.status}, got ${r.status} ${r.raw})`);
        assert.strictEqual(r.raw, ref.raw, `${label}: same body as /api/me`);
        assert.strictEqual(r.status, 403, `${label}: 403`);
        assert.strictEqual(row(email).password_hash, before, `${label}: hash unchanged`);
        if (label === 'expired tester') {
          assert.deepStrictEqual(r.json, { error: 'Subscription required or trial expired.', code: 'tester_expired' }, 'expired tester gets the #38 tester_expired 403');
        } else {
          assert.strictEqual(r.json.code, undefined, `${label}: no tester code`);
        }
      }
    }

    // 7. A failing write is a 500 that logs the user id only: no email, no password.
    const origPrepare = db.prepare.bind(db);
    db.prepare = (sql) => {
      if (/^UPDATE users SET password_hash/.test(sql)) throw new Error('stub write failure');
      return origPrepare(sql);
    };
    const failEmail = 'fail.user@example.com';
    seed(failEmail);
    let fail;
    try { fail = await setPw(port, failEmail, { password: NEW_PW }); } finally { db.prepare = origPrepare; }
    assert.strictEqual(fail.status, 500, 'write failure is 500');
    assert.deepStrictEqual(fail.json, { error: 'Could not save password' }, 'write failure body');
    const failLine = lines.find((l) => l.includes('[auth] set password failed'));
    assert.ok(failLine && failLine.includes(`user ${row(failEmail).id}`), 'failure log names the user id');
    assert.ok(!failLine.includes('@'), 'failure log has no email address');
    assert.strictEqual(row(failEmail).password_hash, null, 'nothing stored on a failed write');

    // 8. No plaintext password in any response or log line; no route log line has an email.
    for (const p of PLAINS) {
      assert.ok(!responses.some((raw) => raw.includes(p)), `no response contains a submitted password (${p.length} chars)`);
      assert.ok(!lines.some((l) => l.includes(p)), `no log line contains a submitted password (${p.length} chars)`);
    }
    assert.ok(!responses.some((raw) => raw.includes('$2a$') || raw.includes('$2b$') || raw.includes('password_hash')), 'no hash in any response');
    for (const l of lines.filter((x) => /set.?password/i.test(x))) {
      assert.ok(!l.includes('@'), 'set password log lines carry no email address');
    }

    restore();
    console.log('lib/set-password.test.js passed');
  } finally {
    restore();
    await new Promise((r) => server.close(r));
    try { db.close(); } catch (e) {}
    cleanDb();
  }
}

main().catch((err) => {
  restore();
  console.error(err);
  process.exit(1);
});
