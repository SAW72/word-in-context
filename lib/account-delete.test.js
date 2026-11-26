'use strict';
/**
 * Self-serve account deletion. Temp SQLite and a local mock Whop server only.
 * WHOP_API_KEY is a fake test string. Requests never leave 127.0.0.1.
 */
const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const jwt = require('jsonwebtoken');
const { Webhook } = require('standardwebhooks');

const dbFile = path.join(os.tmpdir(), `wic-account-delete-${process.pid}.db`);
const betasFile = path.join(os.tmpdir(), `wic-account-delete-betas-${process.pid}.json`);
for (const extra of [dbFile, dbFile + '-wal', dbFile + '-shm', betasFile]) {
  try { fs.unlinkSync(extra); } catch (e) {}
}

const WEBHOOK_SECRET = 'whsec_' + Buffer.from('fedcba9876543210fedcba9876543210').toString('base64');
const PLAN = 'plan_W9vAA0xyptzgt';
const FAKE_KEY = 'test-whop-key-not-real';
const PHRASE = 'DELETE MY ACCOUNT';

const SHARE_SENTENCE = 'Share links you already published stay up, and they do not identify you.';
const NOTICE_A = {
  title: 'Delete your account',
  body: 'This permanently deletes your The Word in Context account and its data. This cannot be undone. We will also cancel your plan so it does not renew. Deleting does not refund the current billing period. If you have a billing question, email hello@stewardoftheking.com before you delete. We keep only your bare Whop membership number so a renewal cannot re-create your account. ' + SHARE_SENTENCE,
  successLine: 'Your account is deleted and your plan is canceled. You will not be charged for it again.',
};
const NOTICE_B_WHOP = {
  title: 'Delete your account',
  body: 'We could not cancel your paid plan for you. Deleting your account does not stop billing. To stop future charges, sign in at whop.com with the email you paid with, open Profile, then Orders, choose The Word in Context, and select Cancel membership. You can do this before or after you delete. Deleting does not refund the current billing period. If you have a billing question, email hello@stewardoftheking.com. We keep only your bare Whop membership number so a renewal cannot re-create your account. ' + SHARE_SENTENCE,
  successLine: 'Your account is deleted. Your plan on Whop is still active until you cancel it there.',
};
const NOTICE_B_STRIPE = {
  title: 'Delete your account',
  body: 'We could not cancel your paid plan for you. Deleting your account does not stop billing. To stop future charges, use the cancel link in your billing emails, or email hello@stewardoftheking.com. You can do this before or after you delete. Deleting does not refund the current billing period. ' + SHARE_SENTENCE,
  successLine: 'Your account is deleted. Your paid plan is still active until you cancel it.',
};
const NOTICE_BOTH = {
  title: 'Delete your account',
  body: 'We could not cancel your paid plans for you. Deleting your account does not stop billing. To stop Whop charges, sign in at whop.com with the email you paid with, open Profile, then Orders, choose The Word in Context, and select Cancel membership. To stop Stripe charges, use the cancel link in your billing emails, or email hello@stewardoftheking.com. You can do this before or after you delete. Deleting does not refund the current billing period. We keep only your bare Whop membership number so a renewal cannot re-create your account. ' + SHARE_SENTENCE,
  successLine: 'Your account is deleted. Your paid plans are still active until you cancel them.',
};
const NOTICE_C = {
  title: 'Delete your account',
  body: 'This permanently deletes your The Word in Context account and its data. This cannot be undone. You do not have a paid plan, so there is nothing to cancel. ' + SHARE_SENTENCE,
  successLine: 'Your account is deleted.',
};

process.env.NODE_ENV = 'test';
process.env.WIC_DB_PATH = dbFile;
process.env.WIC_BETAS_PATH = betasFile;
process.env.JWT_SECRET = 'unit-test-jwt-secret-at-least-32-chars';
process.env.ADMIN_PASSWORD = 'unit-test-admin-password';
process.env.TESTER_INVITE_TOKEN = 'unit-test-invite-token-32chars!!';
process.env.XAI_API_KEY = '';
process.env.RESEND_API_KEY = '';
process.env.STRIPE_SECRET_KEY = '';
process.env.STRIPE_WEBHOOK_SECRET = '';
process.env.WHOP_API_KEY = FAKE_KEY;
process.env.WHOP_API_BASE_URL = 'http://127.0.0.1:9';
process.env.WHOP_CHECKOUT_URL_MONTHLY = 'https://whop.com/checkout/test-plan';
process.env.WHOP_CHECKOUT_URL_YEARLY = '';
process.env.WHOP_WEBHOOK_SECRET = WEBHOOK_SECRET;
process.env.WHOP_PLAN_IDS = PLAN;
process.env.ACCOUNT_DELETE_RATE_MAX = '1000';
process.env.ACCOUNT_DELETE_RATE_WINDOW_MS = '900000';

const { app, db, accountDeleteLimiter, activateWhopMembership } = require('../server');
const wh = new Webhook(WEBHOOK_SECRET);

const captured = [];
const origLog = console.log;
const origErr = console.error;
console.log = (...args) => {
  captured.push(args.map((a) => (typeof a === 'string' ? a : '')).join(' '));
  origLog(...args);
};
console.error = (...args) => {
  captured.push(args.map((a) => (typeof a === 'string' ? a : '')).join(' '));
  origErr(...args);
};

const mock = { status: 200, hold: null, requests: [] };
let releaseHold = () => {};

function startMock() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        mock.requests.push({
          method: req.method,
          url: req.url,
          headers: req.headers,
          body: Buffer.concat(chunks).toString('utf8'),
        });
        const send = () => {
          const headers = { 'Content-Type': 'application/json' };
          if (mock.status === 302) headers.Location = '/should-not-follow';
          res.writeHead(mock.status, headers);
          res.end('{}');
        };
        if (mock.hold) mock.hold.then(send, send);
        else send();
      });
    });
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

function listenApp() {
  return new Promise((resolve) => {
    const server = http.createServer(app);
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
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
        resolve({ status: res.statusCode, json, raw, headers: res.headers });
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

function sha256(token) {
  return crypto.createHash('sha256').update(String(token)).digest('hex');
}

function insertUser({ email, status = 'active', access = 1, whop = null, stripeSub = null }) {
  const info = db.prepare(`
    INSERT INTO users (email, status, access_granted, whop_membership_id, stripe_subscription_id)
    VALUES (?, ?, ?, ?, ?)
  `).run(email, status, access, whop, stripeSub);
  return db.prepare('SELECT * FROM users WHERE id = ?').get(info.lastInsertRowid);
}

function userToken(row, extra) {
  return jwt.sign({ email: row.email, id: row.id, ...extra }, process.env.JWT_SECRET, { expiresIn: '1h' });
}

function authHeaders(token, extra) {
  return { Authorization: 'Bearer ' + token, ...extra };
}

function rememberNotice(res) {
  if (!res || !res.json || !res.json.notice || !res.json.notice.body) return;
  assert.ok(res.json.notice.body.includes(SHARE_SENTENCE), 'every notice body includes the share-link sentence');
  const blob = JSON.stringify(res.json.notice);
  const claims = blob.includes('will not be charged') || blob.includes('is canceled');
  if (!claims) return;
  if (res.json.ok === true) {
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.json.canceled, true, 'notice A text only after a 2xx cancel');
    assert.strictEqual(res.json.billing, 'will_cancel');
    return;
  }
  assert.strictEqual(res.json.billing, 'will_cancel', 'notice A text only on the will_cancel start warning or a 2xx cancel');
  assert.ok(res.json.confirmToken);
}

function startDelete(port, token, headers) {
  return request(port, {
    method: 'POST',
    path: '/api/account/delete/start',
    headers: token ? authHeaders(token, headers) : headers,
    body: {},
  }).then((res) => {
    rememberNotice(res);
    return res;
  });
}

function confirmDelete(port, token, confirmToken, phrase, headers, extra) {
  return request(port, {
    method: 'POST',
    path: '/api/account/delete/confirm',
    headers: token ? authHeaders(token, headers) : headers,
    body: Object.assign({ confirmToken, phrase }, extra || {}),
  }).then((res) => {
    rememberNotice(res);
    return res;
  });
}

function me(port, token) {
  return request(port, { method: 'GET', path: '/api/me', headers: { Authorization: 'Bearer ' + token } });
}

function userByEmail(email) {
  return db.prepare('SELECT * FROM users WHERE email = ?').get(email);
}

function tombstone(id) {
  return db.prepare('SELECT * FROM deleted_whop_memberships WHERE membership_id = ?').get(id);
}

function magicFor(email) {
  return db.prepare('SELECT * FROM magic_tokens WHERE lower(email) = lower(?)').all(email);
}

function assertNoKey(text, label) {
  assert.ok(!String(text).includes(FAKE_KEY), label + ': log must not contain the Whop key');
}

function assertCancelCall(id) {
  const hits = mock.requests.filter((r) => r.url === '/api/v1/memberships/' + encodeURIComponent(id) + '/cancel');
  assert.strictEqual(hits.length, 1, 'exactly one cancel POST for ' + id);
  const hit = hits[0];
  assert.strictEqual(hit.method, 'POST');
  assert.strictEqual(hit.headers.authorization, 'Bearer ' + FAKE_KEY);
  assert.strictEqual(hit.headers['idempotency-key'], 'twic-delete-' + id);
  assert.ok(String(hit.headers['content-type'] || '').includes('application/json'));
  assert.strictEqual(hit.body, '{}');
}

function waitFor(fn, ms) {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const tick = () => {
      if (fn()) return resolve();
      if (Date.now() - start > (ms || 2000)) return reject(new Error('timed out waiting for mock'));
      setTimeout(tick, 10);
    };
    tick();
  });
}

let msgN = 0;
function postWebhook(port, event) {
  const id = 'msg_delete_' + (++msgN);
  const timestamp = new Date();
  const body = { ...event, timestamp: timestamp.toISOString() };
  const payload = JSON.stringify(body);
  return request(port, {
    method: 'POST',
    path: '/api/whop-webhook',
    headers: {
      'Content-Type': 'application/json',
      'webhook-id': id,
      'webhook-timestamp': String(Math.floor(timestamp.getTime() / 1000)),
      'webhook-signature': wh.sign(id, timestamp, payload),
    },
    body: payload,
  });
}

async function main() {
  const mockServer = await startMock();
  process.env.WHOP_API_BASE_URL = 'http://127.0.0.1:' + mockServer.address().port;
  const { server, port } = await listenApp();
  accountDeleteLimiter.reset();
  try {
    const cols = db.prepare('PRAGMA table_info(deleted_whop_memberships)').all().map((c) => c.name);
    assert.deepStrictEqual(cols, ['membership_id', 'deleted_at'], 'tombstone stores only id and timestamp');
    const tokenCols = db.prepare('PRAGMA table_info(account_delete_tokens)').all().map((c) => c.name);
    assert.deepStrictEqual(tokenCols, ['token_hash', 'user_id', 'email', 'expires_at', 'used']);

    fs.writeFileSync(betasFile, JSON.stringify([
      { name: 'Keep', email: 'keep-beta@example.com' },
      { name: 'Gone', email: 'None-User@example.com' },
    ], null, 2));

    // (a) billing none, plus start-again invalidates the earlier token.
    const none = insertUser({ email: 'none-user@example.com', status: 'active', access: 1 });
    db.prepare('INSERT INTO magic_tokens (token, email, expires_at) VALUES (?, ?, ?)').run(
      'magic-none', 'None-User@example.com', '2099-01-01T00:00:00.000Z'
    );
    db.prepare('INSERT INTO magic_tokens (token, email, expires_at) VALUES (?, ?, ?)').run(
      'magic-keep', 'keep-beta@example.com', '2099-01-01T00:00:00.000Z'
    );
    const noneToken = userToken(none);
    const beforeMock = mock.requests.length;
    const start1 = await startDelete(port, noneToken);
    assert.strictEqual(start1.status, 200, 'start none');
    assert.strictEqual(start1.json.billing, 'none');
    assert.strictEqual(start1.json.phrase, PHRASE);
    assert.deepStrictEqual(start1.json.notice, NOTICE_C);
    assert.ok(start1.json.confirmToken && start1.json.confirmToken.length >= 22);
    const expDelta = Date.parse(start1.json.expiresAt) - Date.now();
    assert.ok(expDelta > 4 * 60 * 1000 && expDelta < 6 * 60 * 1000, 'confirm token TTL is 5 minutes');
    const stored = db.prepare('SELECT * FROM account_delete_tokens WHERE token_hash = ?').get(sha256(start1.json.confirmToken));
    assert.ok(stored, 'token stored by hash');
    assert.notStrictEqual(stored.token_hash, start1.json.confirmToken);
    assert.strictEqual(stored.used, 0);
    assert.strictEqual(mock.requests.length, beforeMock, 'start does not call Whop');

    const start2 = await startDelete(port, noneToken);
    assert.strictEqual(start2.status, 200);
    const stale = await confirmDelete(port, noneToken, start1.json.confirmToken, PHRASE);
    assert.strictEqual(stale.status, 400, 'starting again invalidates the earlier token');
    assert.strictEqual(stale.json.error, 'Confirmation expired or already used. Start again.');
    assert.ok(userByEmail(none.email), 'stale confirm does not delete');

    const confirmed = await confirmDelete(port, noneToken, start2.json.confirmToken, '  ' + PHRASE + '\n');
    assert.strictEqual(confirmed.status, 200);
    assert.strictEqual(confirmed.json.ok, true);
    assert.strictEqual(confirmed.json.billing, 'none');
    assert.strictEqual(confirmed.json.canceled, false);
    assert.deepStrictEqual(confirmed.json.notice, NOTICE_C);
    assert.ok(!userByEmail(none.email), 'user row gone');
    assert.deepStrictEqual(magicFor(none.email), [], 'magic tokens for the email are gone');
    assert.ok(magicFor('keep-beta@example.com').length === 1, 'other magic tokens stay');
    const betas = JSON.parse(fs.readFileSync(betasFile, 'utf8'));
    assert.ok(Array.isArray(betas));
    assert.ok(!betas.some((e) => String(e.email).toLowerCase() === none.email));
    assert.ok(betas.some((e) => e.email === 'keep-beta@example.com'));
    const dead = await me(port, noneToken);
    assert.strictEqual(dead.status, 401, 'old JWT is 401 on /api/me');
    assert.strictEqual(dead.json.error, 'User not found');
    assert.strictEqual(mock.requests.length, beforeMock, 'billing none never calls Whop');

    // Email-only JWT still works for a live row (existing tests sign {email} only).
    const legacy = insertUser({ email: 'legacy-idless@example.com' });
    const emailOnly = jwt.sign({ email: legacy.email }, process.env.JWT_SECRET, { expiresIn: '1h' });
    const legacyMe = await me(port, emailOnly);
    assert.strictEqual(legacyMe.status, 200, 'JWT without id still authenticates');
    const emptyId = jwt.sign({ email: legacy.email, id: '' }, process.env.JWT_SECRET, { expiresIn: '1h' });
    assert.strictEqual((await me(port, emptyId)).status, 200, 'blank id does not trip the mismatch check');

    // Canceled / access revoked can still delete.
    const expired = insertUser({ email: 'expired-user@example.com', status: 'canceled', access: 0 });
    const expiredToken = userToken(expired);
    assert.strictEqual((await me(port, expiredToken)).status, 403, 'canceled user has no app access');
    const expiredStart = await startDelete(port, expiredToken);
    assert.strictEqual(expiredStart.status, 200, 'canceled user can start deletion');
    assert.strictEqual(expiredStart.json.billing, 'none');
    const expiredDone = await confirmDelete(port, expiredToken, expiredStart.json.confirmToken, PHRASE);
    assert.strictEqual(expiredDone.status, 200);
    assert.ok(!userByEmail(expired.email));

    // (b) will_cancel, mock 200.
    mock.status = 200;
    const memB = 'mem_delete_b';
    const paid = insertUser({ email: 'paid-b@example.com', whop: memB });
    const paidToken = userToken(paid);
    const fromB = captured.length;
    const startB = await startDelete(port, paidToken);
    assert.strictEqual(startB.json.billing, 'will_cancel');
    assert.deepStrictEqual(startB.json.notice, NOTICE_A);
    assert.strictEqual(mock.requests.length, beforeMock, 'start still does not call Whop');
    const doneB = await confirmDelete(port, paidToken, startB.json.confirmToken, PHRASE);
    assert.strictEqual(doneB.status, 200);
    assert.strictEqual(doneB.json.canceled, true);
    assert.strictEqual(doneB.json.billing, 'will_cancel');
    assert.deepStrictEqual(doneB.json.notice, NOTICE_A);
    assertCancelCall(memB);
    const stoneB = tombstone(memB);
    assert.ok(stoneB, 'tombstone row exists');
    assert.deepStrictEqual(Object.keys(stoneB), ['membership_id', 'deleted_at']);
    assert.strictEqual(stoneB.membership_id, memB);
    assert.ok(!stoneB.membership_id.includes('@'));
    assert.ok(!userByEmail(paid.email));
    const logsB = captured.slice(fromB).join('\n');
    assert.ok(logsB.includes('[account-delete] whop cancel membership ' + memB + ' status 200'), logsB);
    assertNoKey(logsB, 'will_cancel 200');

    // (c) will_cancel but Whop returns 500. Hold. Do not delete. Fresh token, then deleteAnyway.
    mock.status = 500;
    const memC = 'mem_delete_c';
    const failUser = insertUser({ email: 'paid-c@example.com', whop: memC });
    db.prepare('INSERT INTO magic_tokens (token, email, expires_at) VALUES (?, ?, ?)').run(
      'magic-c', failUser.email, '2099-01-01T00:00:00.000Z'
    );
    const failToken = userToken(failUser);
    const startC = await startDelete(port, failToken);
    assert.strictEqual(startC.json.billing, 'will_cancel');
    const fromC = captured.length;
    const beforeC = mock.requests.length;
    const holdC = await confirmDelete(port, failToken, startC.json.confirmToken, PHRASE);
    assert.strictEqual(holdC.status, 409);
    assert.strictEqual(holdC.json.ok, false);
    assert.strictEqual(holdC.json.billing, 'manual');
    assert.strictEqual(holdC.json.needsDeleteAnyway, true);
    assert.strictEqual(holdC.json.phrase, PHRASE);
    assert.ok(holdC.json.confirmToken && holdC.json.confirmToken !== startC.json.confirmToken);
    const holdExp = Date.parse(holdC.json.expiresAt) - Date.now();
    assert.ok(holdExp > 4 * 60 * 1000 && holdExp < 6 * 60 * 1000, 'fresh confirm token TTL is 5 minutes');
    assert.deepStrictEqual(holdC.json.notice, NOTICE_B_WHOP);
    assert.ok(holdC.json.notice.body.includes('whop.com'));
    assert.ok(holdC.json.notice.body.includes('Profile'));
    assert.ok(userByEmail(failUser.email), '500 does not delete the user');
    assert.ok(magicFor(failUser.email).length === 1, 'magic tokens stay on a hold');
    assert.ok(!tombstone(memC), '500 does not write a tombstone');
    assert.strictEqual(mock.requests.length, beforeC + 1);
    assertCancelCall(memC);
    assert.strictEqual(
      db.prepare('SELECT used FROM account_delete_tokens WHERE token_hash = ?').get(sha256(startC.json.confirmToken)).used,
      1
    );
    const oldRejected = await confirmDelete(port, failToken, startC.json.confirmToken, PHRASE);
    assert.strictEqual(oldRejected.status, 400, 'the token used for the hold is rejected');
    assert.strictEqual(oldRejected.json.error, 'Confirmation expired or already used. Start again.');
    assert.ok(userByEmail(failUser.email));
    const doneC = await confirmDelete(port, failToken, holdC.json.confirmToken, PHRASE, null, { deleteAnyway: true });
    assert.strictEqual(doneC.status, 200);
    assert.strictEqual(doneC.json.ok, true);
    assert.strictEqual(doneC.json.billing, 'manual');
    assert.strictEqual(doneC.json.canceled, false);
    assert.deepStrictEqual(doneC.json.notice, NOTICE_B_WHOP);
    assert.ok(!userByEmail(failUser.email));
    assert.deepStrictEqual(magicFor(failUser.email), []);
    assert.ok(tombstone(memC));
    assert.strictEqual(mock.requests.length, beforeC + 1, 'deleteAnyway does not call Whop again');
    assertCancelCall(memC);
    const logsC = captured.slice(fromC).join('\n');
    assert.ok(logsC.includes('status 500'));
    assertNoKey(logsC, 'will_cancel 500');

    // 3xx is not success (redirect: manual). Hold, do not delete.
    mock.status = 302;
    const memRedirect = 'mem_delete_redirect';
    const redir = insertUser({ email: 'paid-redirect@example.com', whop: memRedirect });
    const redirToken = userToken(redir);
    const startRedir = await startDelete(port, redirToken);
    const doneRedir = await confirmDelete(port, redirToken, startRedir.json.confirmToken, PHRASE);
    assert.strictEqual(doneRedir.status, 409);
    assert.strictEqual(doneRedir.json.needsDeleteAnyway, true);
    assert.deepStrictEqual(doneRedir.json.notice, NOTICE_B_WHOP);
    assert.ok(userByEmail(redir.email));
    assert.ok(!tombstone(memRedirect));
    assert.strictEqual(
      mock.requests.filter((r) => r.url && r.url.indexOf(memRedirect) !== -1).length,
      1,
      '302 is not followed'
    );
    assert.strictEqual(
      mock.requests.filter((r) => r.url && r.url.indexOf(memRedirect) !== -1)[0].body,
      '{}'
    );

    // Throw path (nothing listening) holds and does not tombstone.
    mock.status = 200;
    const memDown = 'mem_delete_down';
    const down = insertUser({ email: 'paid-down@example.com', whop: memDown });
    const downToken = userToken(down);
    const startDown = await startDelete(port, downToken);
    const savedBase = process.env.WHOP_API_BASE_URL;
    const beforeDown = mock.requests.length;
    process.env.WHOP_API_BASE_URL = 'http://127.0.0.1:9';
    const fromDown = captured.length;
    const doneDown = await confirmDelete(port, downToken, startDown.json.confirmToken, PHRASE);
    process.env.WHOP_API_BASE_URL = savedBase;
    assert.strictEqual(doneDown.status, 409);
    assert.strictEqual(doneDown.json.needsDeleteAnyway, true);
    assert.strictEqual(doneDown.json.billing, 'manual');
    assert.deepStrictEqual(doneDown.json.notice, NOTICE_B_WHOP);
    assert.ok(!tombstone(memDown));
    assert.ok(userByEmail(down.email));
    assert.strictEqual(mock.requests.length, beforeDown, 'a refused connection does not hit the mock');
    const logsDown = captured.slice(fromDown).join('\n');
    assert.ok(logsDown.includes('[account-delete] whop cancel membership ' + memDown + ' status error'), logsDown);
    assertNoKey(logsDown, 'whop down');

    // Whop + Stripe with a key: manual, Whop is not called, delete only with deleteAnyway.
    mock.status = 200;
    const memBoth = 'mem_delete_both';
    const both = insertUser({ email: 'paid-both@example.com', whop: memBoth, stripeSub: 'sub_both' });
    const bothToken = userToken(both);
    const beforeBoth = mock.requests.length;
    const startBoth = await startDelete(port, bothToken);
    assert.strictEqual(startBoth.json.billing, 'manual');
    assert.deepStrictEqual(startBoth.json.notice, NOTICE_BOTH);
    assert.ok(startBoth.json.notice.body.includes('whop.com'));
    assert.ok(startBoth.json.notice.body.includes('hello@stewardoftheking.com'));
    const holdBoth = await confirmDelete(port, bothToken, startBoth.json.confirmToken, PHRASE);
    assert.strictEqual(holdBoth.status, 409);
    assert.strictEqual(holdBoth.json.needsDeleteAnyway, true);
    assert.deepStrictEqual(holdBoth.json.notice, NOTICE_BOTH);
    assert.ok(userByEmail(both.email));
    assert.ok(!tombstone(memBoth));
    const doneBoth = await confirmDelete(port, bothToken, holdBoth.json.confirmToken, PHRASE, null, { deleteAnyway: true });
    assert.strictEqual(doneBoth.status, 200);
    assert.strictEqual(doneBoth.json.ok, true);
    assert.strictEqual(doneBoth.json.billing, 'manual');
    assert.strictEqual(doneBoth.json.canceled, false);
    assert.deepStrictEqual(doneBoth.json.notice, NOTICE_BOTH);
    assert.ok(!userByEmail(both.email));
    assert.ok(tombstone(memBoth), 'Whop id is still tombstoned when the row is deleted');
    assert.strictEqual(mock.requests.length, beforeBoth, 'Stripe on the row means Whop is not called');
    for (const notice of [startBoth.json.notice, holdBoth.json.notice, doneBoth.json.notice]) {
      const blob = JSON.stringify(notice);
      assert.ok(!blob.includes('will not be charged'));
      assert.ok(!blob.includes('is canceled'));
    }

    // (d) membership but no API key: manual notice, hold, then deleteAnyway. No mock request.
    delete process.env.WHOP_API_KEY;
    const memD = 'mem_delete_d';
    const manual = insertUser({ email: 'paid-d@example.com', whop: memD });
    const manualToken = userToken(manual);
    const beforeD = mock.requests.length;
    const startD = await startDelete(port, manualToken);
    assert.strictEqual(startD.status, 200);
    assert.strictEqual(startD.json.billing, 'manual');
    assert.deepStrictEqual(startD.json.notice, NOTICE_B_WHOP);
    const holdD = await confirmDelete(port, manualToken, startD.json.confirmToken, PHRASE);
    assert.strictEqual(holdD.status, 409);
    assert.strictEqual(holdD.json.needsDeleteAnyway, true);
    assert.deepStrictEqual(holdD.json.notice, NOTICE_B_WHOP);
    assert.ok(userByEmail(manual.email), 'manual confirm without deleteAnyway keeps the user');
    assert.ok(!tombstone(memD));
    const doneD = await confirmDelete(port, manualToken, holdD.json.confirmToken, PHRASE, null, { deleteAnyway: true });
    assert.strictEqual(doneD.status, 200);
    assert.strictEqual(doneD.json.canceled, false);
    assert.strictEqual(doneD.json.billing, 'manual');
    assert.deepStrictEqual(doneD.json.notice, NOTICE_B_WHOP);
    assert.ok(!userByEmail(manual.email));
    assert.ok(tombstone(memD));
    assert.strictEqual(mock.requests.length, beforeD, 'no key means no Whop request');

    // Whop + Stripe and no key: combined manual notice.
    const bothManual = insertUser({ email: 'both-manual@example.com', whop: 'mem_both_manual', stripeSub: 'sub_manual' });
    const bothManualStart = await startDelete(port, userToken(bothManual));
    assert.strictEqual(bothManualStart.json.billing, 'manual');
    assert.deepStrictEqual(bothManualStart.json.notice, NOTICE_BOTH);

    // Stripe-only: neutral notice, no Whop name, hold, then deleteAnyway. No mock call.
    const stripeOnly = insertUser({ email: 'stripe-only@example.com', stripeSub: 'sub_only' });
    const beforeStripe = mock.requests.length;
    const stripeStart = await startDelete(port, userToken(stripeOnly));
    assert.strictEqual(stripeStart.json.billing, 'manual');
    assert.deepStrictEqual(stripeStart.json.notice, NOTICE_B_STRIPE);
    assert.ok(!/whop/i.test(stripeStart.json.notice.body));
    assert.ok(!/whop/i.test(stripeStart.json.notice.successLine));
    const stripeHold = await confirmDelete(port, userToken(stripeOnly), stripeStart.json.confirmToken, PHRASE);
    assert.strictEqual(stripeHold.status, 409);
    assert.strictEqual(stripeHold.json.needsDeleteAnyway, true);
    assert.ok(userByEmail(stripeOnly.email));
    const stripeDone = await confirmDelete(port, userToken(stripeOnly), stripeHold.json.confirmToken, PHRASE, null, { deleteAnyway: true });
    assert.strictEqual(stripeDone.status, 200);
    assert.deepStrictEqual(stripeDone.json.notice, NOTICE_B_STRIPE);
    assert.strictEqual(stripeDone.json.billing, 'manual');
    assert.strictEqual(stripeDone.json.canceled, false);
    assert.strictEqual(mock.requests.length, beforeStripe);
    assert.ok(!userByEmail(stripeOnly.email));
    assert.ok(!tombstone('sub_only'));
    process.env.WHOP_API_KEY = FAKE_KEY;

    // betas.json object form, case-insensitive.
    fs.writeFileSync(betasFile, JSON.stringify({
      'Obj-User@example.com': { name: 'Obj', email: 'obj-user@example.com' },
      'keep-obj@example.com': { name: 'Keep', email: 'keep-obj@example.com' },
    }));
    const objUser = insertUser({ email: 'obj-user@example.com' });
    const objStart = await startDelete(port, userToken(objUser));
    const objDone = await confirmDelete(port, userToken(objUser), objStart.json.confirmToken, PHRASE);
    assert.strictEqual(objDone.status, 200);
    const objBetas = JSON.parse(fs.readFileSync(betasFile, 'utf8'));
    assert.ok(!objBetas['Obj-User@example.com']);
    assert.ok(objBetas['keep-obj@example.com']);

    // (e) wrong phrase does not consume the token.
    const phraseUser = insertUser({ email: 'phrase-user@example.com' });
    const phraseToken = userToken(phraseUser);
    const phraseStart = await startDelete(port, phraseToken);
    const wrong = await confirmDelete(port, phraseToken, phraseStart.json.confirmToken, 'delete my account');
    assert.strictEqual(wrong.status, 400);
    assert.strictEqual(wrong.json.error, 'Type DELETE MY ACCOUNT to confirm.');
    assert.ok(userByEmail(phraseUser.email));
    const still = db.prepare('SELECT used FROM account_delete_tokens WHERE token_hash = ?').get(sha256(phraseStart.json.confirmToken));
    assert.strictEqual(still.used, 0, 'wrong phrase does not consume the token');
    const right = await confirmDelete(port, phraseToken, phraseStart.json.confirmToken, PHRASE);
    assert.strictEqual(right.status, 200);
    assert.ok(!userByEmail(phraseUser.email));

    // Another user's token does not confirm this account and is not consumed.
    const owner = insertUser({ email: 'token-owner@example.com' });
    const thief = insertUser({ email: 'token-thief@example.com' });
    const ownerStart = await startDelete(port, userToken(owner));
    const stolen = await confirmDelete(port, userToken(thief), ownerStart.json.confirmToken, PHRASE);
    assert.strictEqual(stolen.status, 400);
    assert.ok(userByEmail(owner.email));
    const ownerStill = db.prepare('SELECT used FROM account_delete_tokens WHERE token_hash = ?').get(sha256(ownerStart.json.confirmToken));
    assert.strictEqual(ownerStill.used, 0);
    const ownerDone = await confirmDelete(port, userToken(owner), ownerStart.json.confirmToken, PHRASE);
    assert.strictEqual(ownerDone.status, 200);

    // (f) second confirm while the first is still talking to Whop is 400.
    mock.status = 200;
    const memF = 'mem_delete_f';
    const race = insertUser({ email: 'race-user@example.com', whop: memF });
    const raceToken = userToken(race);
    const raceStart = await startDelete(port, raceToken);
    let resolveHold;
    mock.hold = new Promise((resolve) => { resolveHold = resolve; });
    releaseHold = () => resolveHold();
    const firstConfirm = confirmDelete(port, raceToken, raceStart.json.confirmToken, PHRASE);
    await waitFor(() => mock.requests.some((r) => r.url && r.url.indexOf(memF) !== -1));
    const second = await confirmDelete(port, raceToken, raceStart.json.confirmToken, PHRASE);
    assert.strictEqual(second.status, 400, 'reused token while the first confirm is in flight');
    assert.strictEqual(second.json.error, 'Confirmation expired or already used. Start again.');
    assert.ok(userByEmail(race.email), 'in-flight replay does not delete early');
    resolveHold();
    mock.hold = null;
    const firstDone = await firstConfirm;
    assert.strictEqual(firstDone.status, 200);
    assert.strictEqual(firstDone.json.canceled, true);
    assert.ok(!userByEmail(race.email));
    const replay = await confirmDelete(port, raceToken, raceStart.json.confirmToken, PHRASE);
    assert.strictEqual(replay.status, 401, 'after deletion the account is gone, so replay is 401');
    assert.strictEqual(replay.json.error, 'User not found');

    // Expired token.
    const oldUser = insertUser({ email: 'expired-token@example.com' });
    const oldJwt = userToken(oldUser);
    const oldStart = await startDelete(port, oldJwt);
    db.prepare('UPDATE account_delete_tokens SET expires_at = ? WHERE token_hash = ?').run(
      '2000-01-01T00:00:00.000Z',
      sha256(oldStart.json.confirmToken)
    );
    const expiredConfirm = await confirmDelete(port, oldJwt, oldStart.json.confirmToken, PHRASE);
    assert.strictEqual(expiredConfirm.status, 400);
    assert.strictEqual(expiredConfirm.json.error, 'Confirmation expired or already used. Start again.');
    assert.ok(userByEmail(oldUser.email));
    assert.strictEqual(
      db.prepare('SELECT used FROM account_delete_tokens WHERE token_hash = ?').get(sha256(oldStart.json.confirmToken)).used,
      0
    );

    // (g) admin JWT, missing email, missing and invalid JWT.
    const victim = insertUser({ email: 'victim-admin@example.com' });
    const admin = jwt.sign({ role: 'admin' }, process.env.JWT_SECRET, { expiresIn: '1h' });
    const adminWithEmail = jwt.sign({ role: 'admin', email: victim.email, id: victim.id }, process.env.JWT_SECRET, { expiresIn: '1h' });
    for (const token of [admin, adminWithEmail]) {
      const s = await startDelete(port, token);
      const c = await confirmDelete(port, token, 'nope', PHRASE);
      assert.strictEqual(s.status, 403, 'admin start');
      assert.strictEqual(c.status, 403, 'admin confirm');
      assert.strictEqual(s.json.error, 'This account cannot be deleted from the app.');
      assert.strictEqual(c.json.error, 'This account cannot be deleted from the app.');
    }
    const noEmail = jwt.sign({ id: victim.id }, process.env.JWT_SECRET, { expiresIn: '1h' });
    const noEmailRes = await startDelete(port, noEmail);
    assert.strictEqual(noEmailRes.status, 403);
    assert.strictEqual(noEmailRes.json.error, 'This account cannot be deleted from the app.');
    const missing = await request(port, { method: 'POST', path: '/api/account/delete/start', body: {} });
    assert.strictEqual(missing.status, 401);
    assert.strictEqual(missing.json.error, 'Authentication required');
    const bad = await startDelete(port, 'not-a-jwt');
    assert.strictEqual(bad.status, 401);
    assert.strictEqual(bad.json.error, 'Invalid or expired token');
    const badConfirm = await confirmDelete(port, 'not-a-jwt', 'x', PHRASE);
    assert.strictEqual(badConfirm.status, 401);
    assert.ok(userByEmail(victim.email));

    // (i) Origin from another site is 403 even without a JWT. Same host and localhost are allowed.
    const evil = await request(port, {
      method: 'POST',
      path: '/api/account/delete/start',
      headers: { Origin: 'https://evil.example' },
      body: {},
    });
    assert.strictEqual(evil.status, 403);
    assert.strictEqual(evil.json.error, 'Cross-origin request refused.');
    const evilAuthed = await startDelete(port, userToken(victim), { Origin: 'https://evil.example' });
    assert.strictEqual(evilAuthed.status, 403);
    assert.ok(userByEmail(victim.email));
    const localOrigin = await request(port, {
      method: 'POST',
      path: '/api/account/delete/start',
      headers: { Origin: 'http://localhost:9999' },
      body: {},
    });
    assert.strictEqual(localOrigin.status, 401, 'localhost origin is allowed, then auth fails');
    const siteOrigin = await request(port, {
      method: 'POST',
      path: '/api/account/delete/confirm',
      headers: { Origin: 'https://www.thewordincontext.org' },
      body: {},
    });
    assert.strictEqual(siteOrigin.status, 401, 'canonical site origin is allowed');
    const sameHost = await startDelete(port, userToken(victim), { Origin: 'http://127.0.0.1:' + port });
    assert.strictEqual(sameHost.status, 200, 'Origin matching Host is allowed');

    // (h) tombstone blocks membership.activated and payment.succeeded.
    const memH = 'mem_delete_h';
    const reviveEmail = 'revive-h@example.com';
    const whopUser = insertUser({ email: 'whop-h@example.com', whop: memH });
    const whopStart = await startDelete(port, userToken(whopUser));
    const whopDone = await confirmDelete(port, userToken(whopUser), whopStart.json.confirmToken, PHRASE);
    assert.strictEqual(whopDone.json.canceled, true);
    assert.ok(tombstone(memH));
    const fromH = captured.length;
    const activated = await postWebhook(port, {
      type: 'membership.activated',
      data: {
        id: memH,
        status: 'active',
        plan: { id: PLAN },
        user: { email: reviveEmail },
      },
    });
    assert.strictEqual(activated.status, 200);
    assert.deepStrictEqual(JSON.parse(activated.raw), { received: true });
    const paidEvent = await postWebhook(port, {
      type: 'payment.succeeded',
      data: {
        id: 'pay_delete_h',
        membership: {
          id: memH,
          status: 'active',
          plan: { id: PLAN },
          user: { email: reviveEmail },
        },
      },
    });
    assert.strictEqual(paidEvent.status, 200);
    const fromDirect = captured.length;
    const direct = await activateWhopMembership({
      id: memH,
      status: 'active',
      plan: { id: PLAN },
      user: { email: reviveEmail },
    }, 'direct');
    assert.strictEqual(direct, null);
    assert.ok(!userByEmail(reviveEmail), 'tombstone does not recreate the user');
    assert.ok(!userByEmail(whopUser.email));
    const linesH = captured.slice(fromH, fromDirect);
    const activatedLine = linesH.find((l) => l.includes('[whop:tombstone] ignored membership.activated for deleted membership ' + memH));
    const paidLine = linesH.find((l) => l.includes('[whop:tombstone] ignored payment.succeeded for deleted membership ' + memH));
    assert.ok(activatedLine, 'activated tombstone log\n' + linesH.join('\n'));
    assert.ok(paidLine, 'payment tombstone log\n' + linesH.join('\n'));
    assert.ok(!activatedLine.includes(reviveEmail) && !activatedLine.includes('@'));
    assert.ok(!paidLine.includes(reviveEmail) && !paidLine.includes('@'));
    assert.ok(!linesH.some((l) => l.includes('[MAGIC LINK for ' + reviveEmail + ']')), 'no login email');
    assert.ok(!linesH.some((l) => l.includes(reviveEmail)), 'tombstone path logs no email');
    const directLine = captured.slice(fromDirect).find((l) => l.includes('[whop:tombstone] ignored direct for deleted membership ' + memH));
    assert.ok(directLine);
    assert.ok(!directLine.includes(reviveEmail));

    // (j) old JWT stays dead after the same email is created again.
    const rebornEmail = 'reborn@example.com';
    const firstLife = insertUser({ email: rebornEmail });
    const oldLifeToken = userToken(firstLife);
    const rebornStart = await startDelete(port, oldLifeToken);
    const rebornDone = await confirmDelete(port, oldLifeToken, rebornStart.json.confirmToken, PHRASE);
    assert.strictEqual(rebornDone.status, 200);
    const secondLife = insertUser({ email: rebornEmail, status: 'active', access: 1 });
    assert.notStrictEqual(String(secondLife.id), String(firstLife.id));
    const oldMe = await me(port, oldLifeToken);
    assert.strictEqual(oldMe.status, 401);
    assert.strictEqual(oldMe.json.error, 'User not found');
    const rebornRetry = await startDelete(port, oldLifeToken);
    assert.strictEqual(rebornRetry.status, 401);
    assert.strictEqual(rebornRetry.json.error, 'User not found');
    const newEmailOnly = jwt.sign({ email: rebornEmail }, process.env.JWT_SECRET, { expiresIn: '1h' });
    assert.strictEqual((await me(port, newEmailOnly)).status, 200, 'a new email-only session for the new row still works');
    assert.ok(userByEmail(rebornEmail));

    // Rate limit. Pre-fill the loopback key, then the next call is 429.
    const candidates = ['127.0.0.1', '::ffff:127.0.0.1', '::1'];
    let limited = null;
    for (const ip of candidates) {
      accountDeleteLimiter.reset();
      const key = 'account-delete:' + ip;
      for (let i = 0; i < accountDeleteLimiter.max; i++) accountDeleteLimiter.check(key);
      const res = await request(port, { method: 'POST', path: '/api/account/delete/start', body: {} });
      if (res.status === 429) {
        limited = res;
        break;
      }
    }
    assert.ok(limited, 'rate limit trips for the loopback address');
    assert.strictEqual(limited.json.error, 'Too many attempts. Try again later.');
    assert.ok(limited.headers['retry-after'], 'Retry-After is set');
    accountDeleteLimiter.reset();

    console.log('account-delete tests passed');
  } finally {
    try { releaseHold(); } catch (e) {}
    mock.hold = null;
    await new Promise((resolve) => server.close(resolve));
    await new Promise((resolve) => mockServer.close(resolve));
    try { db.close(); } catch (e) {}
    for (const extra of [dbFile, dbFile + '-wal', dbFile + '-shm', betasFile]) {
      try { fs.unlinkSync(extra); } catch (e) {}
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
