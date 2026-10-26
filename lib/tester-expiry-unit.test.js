'use strict';
/**
 * Unit checks for lib/tester-expiry.js and the go paid email copy: who is a tester,
 * when the trial is over, the atomic one time claim, and what happens when a send fails.
 */
const assert = require('assert');
const fs = require('fs');
const { Worker } = require('worker_threads');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');
const {
  BILLING_LINK_COLUMNS,
  isBillingFreeTester,
  testerTrialOver,
  isExpiredTester,
  claimTesterExpiredEmail,
  releaseTesterExpiredEmail,
  notifyExpiredTester,
  safeErrorSummary,
} = require('./tester-expiry');
const testerExpiredEmail = require('./tester-expired-email');
const { ensureTesterExpiredEmailColumn } = require('./security');

const NOW = new Date('2026-10-26T12:00:00.000Z');
const PAST = '2026-10-25T12:00:00.000Z';
const FUTURE = '2026-10-27T12:00:00.000Z';
const tester = (extra = {}) => ({ id: 1, email: 't@example.com', status: 'trialing', trial_end: PAST, access_granted: 1, manual_free: 0, ...extra });

// Who is a tester.
assert.strictEqual(isBillingFreeTester(tester()), true, 'trialing with no billing link is a tester');
for (const col of BILLING_LINK_COLUMNS) {
  assert.strictEqual(isBillingFreeTester(tester({ [col]: 'x_1' })), false, `${col} set means billing, not a tester`);
  assert.strictEqual(isBillingFreeTester(tester({ [col]: '' })), true, `${col} empty string is no link`);
  assert.strictEqual(isBillingFreeTester(tester({ [col]: '   ' })), true, `${col} blank is no link`);
}
assert.deepStrictEqual(BILLING_LINK_COLUMNS, ['whop_membership_id', 'whop_member_id', 'whop_status', 'stripe_customer_id', 'stripe_subscription_id']);
for (const mf of [1, '1']) assert.strictEqual(isBillingFreeTester(tester({ manual_free: mf })), false, `manual_free ${mf} is never a tester`);
for (const status of ['active', 'free', 'past_due', 'canceled', 'pending', 'disabled', null, 'Trialing']) {
  assert.strictEqual(isBillingFreeTester(tester({ status })), false, `status ${status} is not a tester`);
}
assert.strictEqual(isBillingFreeTester(null), false);
assert.strictEqual(isBillingFreeTester(undefined), false);

// When the trial is over.
assert.strictEqual(testerTrialOver(tester(), NOW), true, 'past trial_end is over');
assert.strictEqual(testerTrialOver(tester({ trial_end: FUTURE }), NOW), false, 'future trial_end is not over');
assert.strictEqual(testerTrialOver(tester({ trial_end: NOW.toISOString() }), NOW), true, 'trial_end equal to now is over, like login');
assert.strictEqual(testerTrialOver(tester({ trial_end: null }), NOW), true, 'no trial_end is over, like login');
assert.strictEqual(testerTrialOver(tester({ trial_end: 'not a date' }), NOW), true, 'bad trial_end is over, like login');
assert.strictEqual(testerTrialOver(tester({ whop_membership_id: 'mem_1' }), NOW), false, 'Whop trial is never tester over');
assert.strictEqual(isExpiredTester(tester(), NOW), true);
assert.strictEqual(isExpiredTester(tester({ access_granted: 0 }), NOW), false, 'revoked access is not mailed');
assert.strictEqual(isExpiredTester(tester({ manual_free: 1 }), NOW), false, 'manual_free is never expired');

// The email copy.
const copy = testerExpiredEmail({ appBaseUrl: 'https://example.test/' });
assert.strictEqual(copy.subject, 'Your tester access has ended. Start your free trial of The Word in Context');
assert.strictEqual(copy.subscribeUrl, 'https://example.test/#signup');
assert.ok(copy.html.includes('href="https://example.test/#signup"'), 'links to the signup section that opens with the paid plan form');
assert.ok(!copy.html.includes('#pricing'), 'no longer links to the pricing cards, which lead with the tester card');
// The trial paragraph states the card, both renewal prices, and how to cancel; the apostrophe is HTML escaped.
const TRIAL_PARAGRAPH = "To keep studying, start your 7-day free trial of Pro. A payment method is required. When the trial ends, Pro renews automatically at $4.99 every 30 days or $39.99 every 365 days, whichever you pick, until you cancel. Cancel before the trial ends and you won't be charged. You can cancel anytime in your Whop account.";
assert.ok(copy.html.includes(`<p>${TRIAL_PARAGRAPH.replace("'", '&#39;')} Use the same email address so your account carries over.</p>`), 'trial paragraph is the approved text, then the same email sentence');
const renderedText = copy.html.replace(/<[^>]+>/g, ' ').replace(/&#39;/g, "'").replace(/\s+/g, ' ');
assert.ok(renderedText.includes(`${TRIAL_PARAGRAPH} Use the same email address so your account carries over.`), 'rendered email text matches the approved paragraph verbatim');
assert.ok(!copy.html.includes("won't") && copy.html.includes('won&#39;t'), 'apostrophe is escaped in the HTML');
assert.ok(!copy.html.includes('Pick monthly or yearly') && !copy.html.includes('billing starts when the trial ends'), 'old trial wording is gone');
assert.ok(copy.html.includes('<a href="https://example.test/#signup">Start my 7-day free trial</a>'), 'button text matches the trial button on the signup form');
assert.ok(!/paid subscription/.test(copy.html), 'old paid subscription wording is gone');
assert.ok(!copy.html.includes('Choose a plan and subscribe'), 'old button text is gone');
assert.strictEqual((copy.html.match(/<p>/g) || []).length, 6, 'same six paragraphs as before');
const prose = (copy.subject + ' ' + copy.html.replace(/<[^>]+>/g, ' ')).replace(/\S+@\S+/g, ' ');
assert.ok(!/[\u2012\u2013\u2014\u2015]| \u002d |\u002d\u002d/.test(prose), 'no dashes in the email prose');

// DB backed claim, release and notify.
const dbFile = path.join(os.tmpdir(), `wic-tester14-unit-${process.pid}.db`);
const files = [dbFile, dbFile + '-wal', dbFile + '-shm'];
const clean = () => { for (const f of files) { try { fs.unlinkSync(f); } catch (e) {} } };
clean();
const db = new Database(dbFile);
db.pragma('journal_mode = WAL');
db.exec(`CREATE TABLE users (id INTEGER PRIMARY KEY AUTOINCREMENT, email TEXT UNIQUE NOT NULL, stripe_customer_id TEXT, stripe_subscription_id TEXT,
  status TEXT DEFAULT 'trialing', trial_end TEXT, access_granted INTEGER DEFAULT 1, manual_free INTEGER DEFAULT 0,
  whop_membership_id TEXT, whop_member_id TEXT, whop_status TEXT)`);
assert.strictEqual(ensureTesterExpiredEmailColumn(db), true, 'marker column added');
assert.strictEqual(ensureTesterExpiredEmailColumn(db), false, 'marker column migration is a no op the second time');
const col = db.prepare('PRAGMA table_info(users)').all().find((c) => c.name === 'tester_expired_email_at');
assert.ok(col && col.type === 'TEXT' && col.notnull === 0 && col.dflt_value === null, 'marker is nullable TEXT with no default');

function add(email, extra = {}) {
  const r = { status: 'trialing', trial_end: PAST, access_granted: 1, manual_free: 0, whop_membership_id: null, ...extra };
  const info = db.prepare('INSERT INTO users (email, status, trial_end, access_granted, manual_free, whop_membership_id) VALUES (?, ?, ?, ?, ?, ?)')
    .run(email, r.status, r.trial_end, r.access_granted, r.manual_free, r.whop_membership_id);
  return db.prepare('SELECT * FROM users WHERE id = ?').get(info.lastInsertRowid);
}
const marker = (id) => db.prepare('SELECT tester_expired_email_at FROM users WHERE id = ?').get(id).tester_expired_email_at;
const quiet = { log() {}, error() {} };

async function main() {
  try {
    // Claim once, then never again; release only undoes our own stamp.
    const a = add('claim@example.com');
    const c1 = claimTesterExpiredEmail(db, a.id, NOW);
    assert.ok(c1 && c1.stamp === NOW.toISOString(), 'first claim wins');
    assert.strictEqual(claimTesterExpiredEmail(db, a.id, NOW), null, 'second claim loses');
    assert.strictEqual(releaseTesterExpiredEmail(db, a.id, 'some other stamp'), false, 'release with a foreign stamp does nothing');
    assert.strictEqual(marker(a.id), c1.stamp);
    assert.strictEqual(releaseTesterExpiredEmail(db, a.id, c1.stamp), true, 'release with our stamp clears it');
    assert.strictEqual(marker(a.id), null);

    // The claim rechecks the stored row, not the caller's stale copy.
    const b = add('stale@example.com');
    db.prepare("UPDATE users SET whop_membership_id = 'mem_paid' WHERE id = ?").run(b.id);
    assert.strictEqual(claimTesterExpiredEmail(db, b.id, NOW), null, 'row that became Whop since the read is not claimed');
    const sent = [];
    const okSend = async (to, msg) => { sent.push([to, msg.subject]); return { data: { id: 'em_1' }, error: null }; };
    assert.strictEqual(await notifyExpiredTester(db, b, okSend, { appBaseUrl: 'https://x.test', now: NOW, log: quiet }), 'skipped', 'stale tester copy is skipped');
    const mfRow = add('mf@example.com');
    db.prepare('UPDATE users SET manual_free = 1 WHERE id = ?').run(mfRow.id);
    assert.strictEqual(await notifyExpiredTester(db, mfRow, okSend, { now: NOW, log: quiet }), 'skipped', 'became manual_free since the read is skipped');
    assert.strictEqual(sent.length, 0);

    // Not expired, not a tester, no user: skipped without a send.
    assert.strictEqual(await notifyExpiredTester(db, add('future@example.com', { trial_end: FUTURE }), okSend, { now: NOW, log: quiet }), 'skipped');
    assert.strictEqual(await notifyExpiredTester(db, add('whop@example.com', { whop_membership_id: 'mem_w' }), okSend, { now: NOW, log: quiet }), 'skipped');
    assert.strictEqual(await notifyExpiredTester(db, null, okSend, { now: NOW, log: quiet }), 'skipped');
    assert.strictEqual(sent.length, 0, 'nothing sent for non expired rows');

    // A thrown send releases the marker; a reported mailer error releases it too; then a good send keeps it.
    const f = add('fail@example.com');
    let calls = 0;
    const throwSend = async () => { calls++; throw new Error('network down'); };
    assert.strictEqual(await notifyExpiredTester(db, f, throwSend, { now: NOW, log: quiet }), 'failed');
    assert.strictEqual(marker(f.id), null, 'thrown send releases the marker');
    const errSend = async () => { calls++; return { data: null, error: { name: 'validation_error', message: 'bad' } }; };
    assert.strictEqual(await notifyExpiredTester(db, f, errSend, { now: NOW, log: quiet }), 'failed');
    assert.strictEqual(marker(f.id), null, 'Resend error result releases the marker');
    assert.strictEqual(calls, 2);
    assert.strictEqual(await notifyExpiredTester(db, f, okSend, { appBaseUrl: 'https://x.test', now: NOW, log: quiet }), 'sent');
    assert.ok(marker(f.id), 'good send keeps the marker');
    assert.deepStrictEqual(sent, [['fail@example.com', 'Your tester access has ended. Start your free trial of The Word in Context']]);
    assert.strictEqual(await notifyExpiredTester(db, f, okSend, { now: NOW, log: quiet }), 'skipped', 'after a good send it never sends again');
    assert.strictEqual(sent.length, 1);
    // An undefined result (the dev logger path) counts as sent.
    const d = add('devlog@example.com');
    assert.strictEqual(await notifyExpiredTester(db, d, async () => undefined, { now: NOW, log: quiet }), 'sent');

    // Concurrent notifies with a slow mailer: exactly one send.
    const cc = add('concurrent@example.com');
    let slowCalls = 0;
    const slowSend = () => new Promise((r) => { slowCalls++; setTimeout(() => r({ data: { id: 'em' }, error: null }), 20); });
    const outcomes = await Promise.all(Array.from({ length: 25 }, () => notifyExpiredTester(db, cc, slowSend, { now: NOW, log: quiet })));
    assert.strictEqual(slowCalls, 1, 'one send across 25 concurrent calls');
    assert.strictEqual(outcomes.filter((o) => o === 'sent').length, 1);

    // A second connection (another process on the same file) cannot claim it again.
    const other = new Database(dbFile);
    const e = add('twoconn@example.com');
    assert.ok(claimTesterExpiredEmail(other, e.id, NOW), 'first connection claims');
    assert.strictEqual(claimTesterExpiredEmail(db, e.id, NOW), null, 'second connection sees the claim');
    other.close();

    // Once claimed, a later claim takes no write lock: the cheap read sees the marker first.
    const g = add('cheapread@example.com');
    let txCalls = 0;
    const spyDb = { prepare: (sql) => db.prepare(sql), transaction: (fn) => { txCalls++; return db.transaction(fn); } };
    assert.ok(claimTesterExpiredEmail(spyDb, g.id, NOW), 'unclaimed row is claimed');
    assert.strictEqual(txCalls, 1, 'the first claim takes the IMMEDIATE transaction');
    assert.strictEqual(claimTesterExpiredEmail(spyDb, g.id, NOW), null, 'claimed row is not claimed again');
    assert.strictEqual(await notifyExpiredTester(spyDb, g, okSend, { now: NOW, log: quiet }), 'skipped', 'notify with a stale copy is skipped');
    assert.strictEqual(txCalls, 1, 'no transaction once the marker is set');
    assert.strictEqual(claimTesterExpiredEmail(spyDb, 999999, NOW), null, 'missing row is not claimed');
    assert.strictEqual(txCalls, 1, 'no transaction for a missing row');
    // The conditional UPDATE is still the guard when the cheap read is beaten by another writer.
    const h = add('beaten@example.com');
    let raced = false;
    const racyDb = { prepare: (sql) => db.prepare(sql), transaction: (fn) => {
      if (!raced) { raced = true; db.prepare('UPDATE users SET tester_expired_email_at = ? WHERE id = ?').run('other writer', h.id); }
      return db.transaction(fn);
    } };
    assert.strictEqual(claimTesterExpiredEmail(racyDb, h.id, NOW), null, 'claim loses to a writer between the cheap read and the lock');
    assert.strictEqual(marker(h.id), 'other writer', 'the other writer keeps the marker');

    // A failed release is logged once by user id, never swallowed, and never logs the email address.
    const errors = [];
    const errorArgs = [];
    const spyLog = { log() {}, error: (...args) => { errorArgs.push(args); errors.push(args.map(String).join(' ')); } };
    // Every log call is one plain string: no email address, raw message, stack, String(err) or raw error argument.
    const noRawError = (label, email, ...errs) => {
      assert.ok(errorArgs.length > 0, `${label}: something was logged`);
      for (const args of errorArgs) assert.ok(args.length === 1 && typeof args[0] === 'string', `${label}: one plain string per log call, no raw error argument`);
      for (const l of errors) {
        assert.ok(!l.includes('@') && !l.includes(email), `${label}: no email address in log line`);
        assert.ok(!/leak/.test(l), `${label}: no raw error text in log line`);
        for (const e of errs) {
          assert.ok(!l.includes(e.message), `${label}: no raw error message`);
          assert.ok(!l.includes(String(e)), `${label}: no String(err)`);
          assert.ok(!l.includes(e.stack.split('\n')[1].trim()), `${label}: no stack`);
        }
      }
    };
    const resetLog = () => { errors.length = 0; errorArgs.length = 0; };
    const r1 = add('releasethrow@example.com');
    const releaseErr = new Error('disk I/O error for releasethrow@example.com leak');
    const sendErr1 = new Error('send down for releasethrow@example.com leak');
    const throwingReleaseDb = { transaction: (fn) => db.transaction(fn), prepare: (sql) => {
      if (/SET tester_expired_email_at = NULL/.test(sql)) throw releaseErr;
      return db.prepare(sql);
    } };
    assert.strictEqual(await notifyExpiredTester(throwingReleaseDb, r1, async () => { throw sendErr1; }, { now: NOW, log: spyLog }), 'failed');
    assert.deepStrictEqual(errors, [`[tester] go paid email failed for user ${r1.id} (Error); could not release the claim (Error), no retry until it is cleared`], 'a throwing release logs exactly one line, by user id with a safe summary, and no retry promise');
    noRawError('release throw', 'releasethrow@example.com', releaseErr, sendErr1);
    assert.ok(marker(r1.id), 'marker stays when the release fails');
    resetLog();
    const r2 = add('releasemiss@example.com');
    const sendErr2 = Object.assign(new Error('send down for releasemiss@example.com leak'), { code: 'ECONNRESET' });
    const send2 = async () => { db.prepare('UPDATE users SET tester_expired_email_at = ? WHERE id = ?').run('changed', r2.id); throw sendErr2; };
    assert.strictEqual(await notifyExpiredTester(db, r2, send2, { now: NOW, log: spyLog }), 'failed');
    assert.deepStrictEqual(errors, [`[tester] go paid email failed for user ${r2.id} (Error ECONNRESET); claim was not released because the marker changed after our claim, so no retry from here`], 'a release that matched nothing logs exactly one line by user id, with no retry promise');
    noRawError('release miss', 'releasemiss@example.com', sendErr2);
    assert.strictEqual(marker(r2.id), 'changed', 'a foreign marker is left alone');

    // A claim that throws (database busy) is logged once by user id and promises a retry,
    // because no marker was written. Covers the cheap read and the UPDATE inside the transaction.
    for (const [where, match] of [['cheap read', /^SELECT tester_expired_email_at FROM users/], ['claim update', /^UPDATE users SET tester_expired_email_at = \? WHERE id = \? AND/]]) {
      resetLog();
      const b = add(`claimthrow.${where.replace(' ', '')}@example.com`);
      const busyErr = Object.assign(new Error(`database is locked for ${b.email} leak`), { code: 'SQLITE_BUSY' });
      let matched = 0;
      const busyDb = { transaction: (fn) => db.transaction(fn), prepare: (sql) => { if (match.test(sql)) { matched++; throw busyErr; } return db.prepare(sql); } };
      let sends = 0;
      assert.strictEqual(await notifyExpiredTester(busyDb, b, async () => { sends++; return { data: { id: 'em' }, error: null }; }, { now: NOW, log: spyLog }), 'failed', `${where} throws: notify returns failed`);
      assert.strictEqual(matched, 1, `${where} throws: the fault was hit`);
      assert.deepStrictEqual(errors, [`[tester] go paid email failed for user ${b.id} before a claim (Error SQLITE_BUSY); will retry on a later request`], `${where} throws: exactly one safe line with a retry promise`);
      noRawError(`${where} throws`, b.email, busyErr);
      assert.strictEqual(sends, 0, `${where} throws: nothing is sent`);
      assert.strictEqual(marker(b.id), null, `${where} throws: no marker, so a later request retries`);
    }

    // Hostile errors: a throwing name getter, a throwing code getter, or a Proxy whose get trap throws.
    // notify still resolves 'failed', logs 'unknown error' only, releases the claim, and leaves no unhandled rejection.
    const unhandled = [];
    const onUnhandled = (reason) => unhandled.push(reason);
    process.on('unhandledRejection', onUnhandled);
    const trap = () => { throw new Error('getter for hostile@example.com leak'); };
    const hostile = {
      'name getter': () => { const e = new Error('name getter for hostile@example.com leak'); Object.defineProperty(e, 'name', { get: trap }); return e; },
      'code getter': () => { const e = new Error('code getter for hostile@example.com leak'); Object.defineProperty(e, 'code', { get: trap }); return e; },
      'proxy trap': () => new Proxy(new Error('proxy for hostile@example.com leak'), { get: trap }),
    };
    for (const [label, makeErr] of Object.entries(hostile)) {
      resetLog();
      const hu = add(`hostile.${label.replace(' ', '')}@example.com`);
      let ret;
      try {
        ret = await notifyExpiredTester(db, hu, async () => { throw makeErr(); }, { now: NOW, log: spyLog });
      } catch (e) {
        ret = 'rejected';
      }
      assert.strictEqual(ret, 'failed', `${label}: notify resolves failed and never rejects`);
      assert.deepStrictEqual(errors, [`[tester] go paid email failed for user ${hu.id} (unknown error); will retry on a later request`], `${label}: one safe line`);
      for (const l of errors) assert.ok(!l.includes('@') && !/leak/.test(l), `${label}: no address or raw text`);
      assert.strictEqual(marker(hu.id), null, `${label}: claim released, so a later request retries`);
      // Fire and forget like requireAuth: nothing may escape as an unhandled rejection.
      const again = add(`hostile.again.${label.replace(' ', '')}@example.com`);
      notifyExpiredTester(db, again, async () => { throw makeErr(); }, { now: NOW, log: quiet });
      await new Promise((r) => setTimeout(r, 20));
      assert.strictEqual(marker(again.id), null, `${label}: fire and forget call released its claim`);
    }
    // A hostile release error is summarized safely too.
    resetLog();
    const hr = add('hostile.release@example.com');
    const hostileReleaseDb = { transaction: (fn) => db.transaction(fn), prepare: (sql) => {
      if (/SET tester_expired_email_at = NULL/.test(sql)) throw hostile['proxy trap']();
      return db.prepare(sql);
    } };
    let hrRet;
    try { hrRet = await notifyExpiredTester(hostileReleaseDb, hr, async () => { throw new Error('send down'); }, { now: NOW, log: spyLog }); } catch (e) { hrRet = 'rejected'; }
    assert.strictEqual(hrRet, 'failed', 'hostile release error: notify resolves failed');
    assert.deepStrictEqual(errors, [`[tester] go paid email failed for user ${hr.id} (Error); could not release the claim (unknown error), no retry until it is cleared`], 'hostile release error: one safe line');
    await new Promise((r) => setTimeout(r, 20));
    process.removeListener('unhandledRejection', onUnhandled);
    assert.strictEqual(unhandled.length, 0, 'no unhandled rejection from hostile errors');
    for (const [label, makeErr] of Object.entries(hostile)) assert.strictEqual(safeErrorSummary(makeErr()), 'unknown error', `${label}: safeErrorSummary never throws`);

    // Log lines name the user id only: no email address and no raw mailer message on any path.
    const lines = [];
    const capLog = { log: (...args) => lines.push(args.map(String).join(' ')), error: (...args) => lines.push(args.map(String).join(' ')) };
    const noAddress = (label) => {
      assert.ok(lines.length > 0, `${label}: something was logged`);
      for (const l of lines) {
        assert.ok(!/@/.test(l), `${label}: no email address in log line: ${l.replace(/@/g, ' at ')}`);
        assert.ok(!/leak|Invalid to/.test(l), `${label}: no raw mailer message in log line`);
      }
    };
    const pl = add('privacy.log@example.com');
    lines.length = 0;
    assert.strictEqual(await notifyExpiredTester(db, pl, async (to) => ({ data: null, error: { name: 'validation_error', message: `Invalid to field: ${to} leak` } }), { now: NOW, log: capLog }), 'failed');
    noAddress('error result');
    assert.ok(lines.some((l) => l === `[tester] go paid email failed for user ${pl.id} (validation_error); will retry on a later request`), 'error result: safe summary and a retry promise after the release');
    lines.length = 0;
    assert.strictEqual(await notifyExpiredTester(db, pl, async (to) => { throw Object.assign(new Error(`connect failed for ${to} leak`), { code: 'ECONNRESET' }); }, { now: NOW, log: capLog }), 'failed');
    noAddress('throw');
    assert.ok(lines.some((l) => l === `[tester] go paid email failed for user ${pl.id} (Error ECONNRESET); will retry on a later request`), 'throw: name and code only');
    lines.length = 0;
    assert.strictEqual(await notifyExpiredTester(db, pl, (to) => Promise.reject(new Error(`rejected ${to} leak`)), { now: NOW, log: capLog }), 'failed');
    noAddress('reject');
    lines.length = 0;
    assert.strictEqual(await notifyExpiredTester(db, pl, async () => ({ data: { id: 'em' }, error: null }), { now: NOW, log: capLog }), 'sent');
    noAddress('success');
    assert.deepStrictEqual(lines, [`[tester] go paid email sent for user ${pl.id}`], 'success logs the user id only');
    assert.strictEqual(safeErrorSummary({ name: 'bad name with a@b.c', code: 'x@y.z' }), 'unknown error', 'odd names and codes are never logged');
    assert.strictEqual(safeErrorSummary(null), 'unknown error');
    // Numeric codes are logged as digits, and a code equal to the name is logged once.
    assert.strictEqual(safeErrorSummary({ name: 'rate_limit_exceeded', code: 429 }), 'rate_limit_exceeded 429', 'numeric code is kept');
    assert.strictEqual(safeErrorSummary({ name: 'ECONNRESET', code: 'ECONNRESET' }), 'ECONNRESET', 'code equal to the name is not repeated');
    assert.strictEqual(safeErrorSummary({ code: 503 }), '503', 'numeric code alone');
    const nc = add('numeric.code@example.com');
    lines.length = 0;
    assert.strictEqual(await notifyExpiredTester(db, nc, async (to) => ({ data: null, error: { name: 'rate_limit_exceeded', code: 429, message: `slow down ${to} leak` } }), { now: NOW, log: capLog }), 'failed');
    noAddress('numeric code');
    assert.deepStrictEqual(lines, [`[tester] go paid email failed for user ${nc.id} (rate_limit_exceeded 429); will retry on a later request`], 'error result with a numeric code: name and code only');

    // Cross connection race: worker threads, each with its own connection, claim at the same instant.
    const race = add('crossconn@example.com');
    const WORKERS = 8;
    const gate = new Int32Array(new SharedArrayBuffer(4));
    const workerSrc = `
      const { parentPort, workerData } = require('worker_threads');
      const Database = require(workerData.bsq);
      const { claimTesterExpiredEmail } = require(workerData.lib);
      const conn = new Database(workerData.dbFile, { timeout: 5000 });
      parentPort.postMessage({ ready: true });
      Atomics.wait(workerData.gate, 0, 0);
      let won = false, error = null;
      try { won = !!claimTesterExpiredEmail(conn, workerData.id, new Date(workerData.now)); } catch (e) { error = e.message; }
      conn.close();
      parentPort.postMessage({ won, error });`;
    const results = await new Promise((resolve, reject) => {
      const out = []; let ready = 0;
      for (let i = 0; i < WORKERS; i++) {
        const w = new Worker(workerSrc, { eval: true, workerData: { bsq: require.resolve('better-sqlite3'), lib: require.resolve('./tester-expiry'), dbFile, id: race.id, now: NOW.toISOString(), gate } });
        w.on('error', reject);
        w.on('message', (m) => {
          if (m.ready) { if (++ready === WORKERS) { Atomics.store(gate, 0, 1); Atomics.notify(gate, 0); } return; }
          out.push(m); if (out.length === WORKERS) resolve(out);
        });
      }
    });
    assert.deepStrictEqual(results.filter((r) => r.error), [], 'no connection errors in the race');
    assert.strictEqual(results.filter((r) => r.won).length, 1, `exactly one of ${WORKERS} connections wins the claim`);
    assert.ok(marker(race.id), 'the winner left the marker');

    console.log('lib/tester-expiry-unit.test.js passed');
  } finally {
    try { db.close(); } catch (e) {}
    clean();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
