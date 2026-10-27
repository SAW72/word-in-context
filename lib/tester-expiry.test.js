'use strict';
/**
 * 14 day testers: when trial_end passes they lose access and get one go paid email.
 * Free forever (manual_free=1) is never cut off or mailed. 7 day Whop trials, Stripe
 * trials and paid users keep the access they had before. HTTP level, real server.js.
 */
const assert = require('assert');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const { Webhook } = require('standardwebhooks');

const dbFile = path.join(os.tmpdir(), `wic-tester14-${process.pid}.db`);
function cleanDb() {
  for (const f of [dbFile, dbFile + '-wal', dbFile + '-shm']) {
    try { fs.unlinkSync(f); } catch (e) {}
  }
}
cleanDb();

const WEBHOOK_SECRET = 'whsec_' + Buffer.from('0123456789abcdef0123456789abcdef').toString('base64');
const PLAN = 'plan_W9vAA0xyptzgt';
const INVITE = 'unit-test-invite-token-32chars!!';
const SUBJECT = 'Your tester access has ended. Start your free trial of The Word in Context';

process.env.NODE_ENV = 'test';
process.env.WIC_DB_PATH = dbFile;
process.env.JWT_SECRET = 'unit-test-jwt-secret-at-least-32-chars';
process.env.ADMIN_PASSWORD = 'unit-test-admin-password';
process.env.TESTER_INVITE_TOKEN = INVITE;
process.env.XAI_API_KEY = '';
process.env.RESEND_API_KEY = '';
process.env.WHOP_CHECKOUT_URL_MONTHLY = 'https://whop.com/checkout/test-plan';
process.env.WHOP_CHECKOUT_URL_YEARLY = '';
process.env.WHOP_WEBHOOK_SECRET = WEBHOOK_SECRET;
process.env.WHOP_PLAN_IDS = PLAN;
process.env.STRIPE_SECRET_KEY = 'sk_test_unit_only_not_a_real_key';
process.env.STRIPE_WEBHOOK_SECRET = 'whsec_unit_test_stripe_secret';
process.env.TRIAL_DAYS = '7';
process.env.TESTER_TRIAL_DAYS = '14';

const { app, db } = require('../server');
const wh = new Webhook(WEBHOOK_SECRET);

const captured = [];
const origLog = console.log;
console.log = (...args) => {
  captured.push(args.map((a) => (typeof a === 'string' ? a : '')).join(' '));
  origLog(...args);
};

const PW = 'tester-pass-unit-99';
const HASH = bcrypt.hashSync(PW, 4);
const PAST = '2020-01-01T00:00:00.000Z';
const FUTURE = new Date(Date.now() + 5 * 86400000).toISOString();

function listen() {
  return new Promise((resolve) => {
    const server = http.createServer(app);
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

function request(port, { method, path: urlPath, headers, body }) {
  return new Promise((resolve, reject) => {
    const payload = body == null ? null : Buffer.from(body);
    const req = http.request({
      hostname: '127.0.0.1', port, method, path: urlPath,
      headers: { ...(payload ? { 'Content-Length': payload.length } : {}), ...headers },
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = JSON.parse(raw); } catch (e) {}
        resolve({ status: res.statusCode, raw, json });
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

const json = (port, method, p, body, headers = {}) => request(port, {
  method, path: p, headers: { 'Content-Type': 'application/json', ...headers }, body: body === undefined ? undefined : JSON.stringify(body),
});
const adminToken = () => jwt.sign({ role: 'admin' }, process.env.JWT_SECRET, { expiresIn: '1h' });
const me = (port, email) => request(port, { method: 'GET', path: '/api/me', headers: { Authorization: 'Bearer ' + jwt.sign({ email }, process.env.JWT_SECRET, { expiresIn: '1h' }) } });
const login = (port, email, password = PW) => json(port, 'POST', '/api/login', { email, password });
function magic(port, email) {
  const token = 'unit-magic-' + email + '-' + Math.random().toString(36).slice(2);
  db.prepare('INSERT OR REPLACE INTO magic_tokens (token, email, expires_at) VALUES (?, ?, ?)').run(token, email, new Date(Date.now() + 600000).toISOString());
  return request(port, { method: 'GET', path: '/api/verify-magic?token=' + encodeURIComponent(token) });
}
let msgN = 0;
function postWebhook(port, event) {
  const id = 'msg_tester14_' + (++msgN);
  const ts = new Date();
  const payload = JSON.stringify({ ...event, timestamp: ts.toISOString() });
  return request(port, {
    method: 'POST', path: '/api/whop-webhook',
    headers: { 'Content-Type': 'application/json', 'webhook-id': id, 'webhook-timestamp': String(Math.floor(ts.getTime() / 1000)), 'webhook-signature': wh.sign(id, ts, payload) },
    body: payload,
  });
}

const row = (email) => db.prepare('SELECT * FROM users WHERE email = ?').get(email);
const goPaidMail = (email) => captured.filter((l) => l.includes(`[WHOP EMAIL to ${email}] ${SUBJECT}`)).length;
const anyMail = (email, from = 0) => captured.slice(from).filter((l) => l.includes(`[WHOP EMAIL to ${email}]`) || l.includes(`[MAGIC LINK for ${email}]`)).length;
const tick = () => new Promise((r) => setImmediate(r));

function seed(email, { status = 'trialing', trialEnd = PAST, manualFree = 0, access = 1, membership = null, member = null, stripeCustomer = null, stripeSub = null, whopStatus = null } = {}) {
  db.prepare(`INSERT INTO users (email, status, trial_end, access_granted, manual_free, password_hash, whop_membership_id, whop_member_id, stripe_customer_id, stripe_subscription_id, whop_status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(email, status, trialEnd, access, manualFree, HASH, membership, member, stripeCustomer, stripeSub, whopStatus);
}
const expire = (email) => db.prepare('UPDATE users SET trial_end = ? WHERE email = ?').run(PAST, email);

// Access is unchanged and no go paid email for a row that is not a tester.
async function expectKeepsAccess(port, email, label, { meStatus = 200 } = {}) {
  const from = captured.length;
  const r1 = await me(port, email);
  const r2 = await me(port, email);
  await tick();
  assert.strictEqual(r1.status, meStatus, `${label}: /api/me ${meStatus} (got ${r1.status} ${r1.raw})`);
  assert.strictEqual(r2.status, meStatus, `${label}: /api/me ${meStatus} again`);
  assert.strictEqual(goPaidMail(email), 0, `${label}: no go paid email`);
  assert.strictEqual(anyMail(email, from), 0, `${label}: no mail at all from /api/me`);
  assert.strictEqual(row(email).tester_expired_email_at == null, true, `${label}: no marker`);
}

async function main() {
  const { server, port } = await listen();
  try {
    // 1. Real invite signup, then the 14 days run out: cut off, one email.
    const t1 = 'tester.expired.one@example.com';
    const su = await json(port, 'POST', '/api/tester-signup', { email: t1, password: PW, inviteToken: INVITE });
    assert.strictEqual(su.status, 200, `tester signup 200 (got ${su.status} ${su.raw})`);
    const fresh = await me(port, t1);
    assert.strictEqual(fresh.status, 200, 'unexpired tester keeps access');
    assert.strictEqual(goPaidMail(t1), 0, 'unexpired tester gets no go paid email');
    expire(t1);
    const cut = await me(port, t1);
    await tick();
    assert.strictEqual(cut.status, 403, `expired tester is cut off on /api/me (got ${cut.status} ${cut.raw})`);
    assert.strictEqual(cut.json && cut.json.error, 'Subscription required or trial expired.', 'expired tester 403 message');
    assert.strictEqual(goPaidMail(t1), 1, 'expired tester gets the go paid email');
    assert.ok(row(t1).tester_expired_email_at, 'marker set after the email');
    assert.strictEqual(row(t1).status, 'trialing', 'status is not rewritten');
    // Repeated requests on every cut off path: still exactly one email.
    for (let i = 0; i < 3; i++) assert.strictEqual((await me(port, t1)).status, 403, 'still cut off');
    assert.strictEqual((await login(port, t1)).status, 403, 'expired tester password login 403');
    assert.strictEqual((await magic(port, t1)).status, 403, 'expired tester magic link 403');
    await tick();
    assert.strictEqual(goPaidMail(t1), 1, 'repeated requests send no second email');

    // 2. Concurrent first requests: exactly one email.
    const t2 = 'tester.concurrent@example.com';
    seed(t2);
    const results = await Promise.all(Array.from({ length: 30 }, (_, i) => (i % 3 === 0 ? login(port, t2) : i % 3 === 1 ? me(port, t2) : magic(port, t2))));
    await tick();
    assert.ok(results.every((r) => r.status === 403), 'every concurrent request is cut off');
    assert.strictEqual(goPaidMail(t2), 1, 'concurrent requests send exactly one email');

    // 3. Admin special tester (create-special-tester) runs out too.
    const t3 = 'tester.special@example.com';
    const sp = await json(port, 'POST', '/api/admin/create-special-tester', { email: t3, days: 14 }, { Authorization: 'Bearer ' + adminToken() });
    assert.strictEqual(sp.status, 200, 'special tester created');
    expire(t3);
    assert.strictEqual((await me(port, t3)).status, 403, 'expired special tester cut off');
    await tick();
    assert.strictEqual(goPaidMail(t3), 1, 'expired special tester gets one email');

    // 4. Login first and magic link first also send it (stale JWT not needed).
    const t4 = 'tester.loginfirst@example.com';
    seed(t4);
    assert.strictEqual((await login(port, t4, 'wrong-password-1')).status, 401, 'wrong password 401');
    await tick();
    assert.strictEqual(goPaidMail(t4), 0, 'wrong password sends nothing');
    assert.strictEqual((await login(port, t4)).status, 403, 'expired tester login 403');
    await tick();
    assert.strictEqual(goPaidMail(t4), 1, 'login sends the email once');
    const t5 = 'tester.magicfirst@example.com';
    seed(t5);
    assert.strictEqual((await magic(port, t5)).status, 403, 'expired tester magic 403');
    await tick();
    assert.strictEqual(goPaidMail(t5), 1, 'magic link sends the email once');

    // 5. Free forever is never cut off or mailed, even with a tester shaped expired row.
    const mf1 = 'mf.tester.shaped@example.com';
    seed(mf1, { manualFree: 1 });
    await expectKeepsAccess(port, mf1, 'manual_free trialing past trial_end');
    assert.strictEqual((await login(port, mf1)).status, 200, 'manual_free login 200');
    assert.strictEqual((await magic(port, mf1)).status, 200, 'manual_free magic 200');
    const mf2 = 'mf.free@example.com';
    seed(mf2, { status: 'free', manualFree: 1, trialEnd: null });
    await expectKeepsAccess(port, mf2, 'manual_free free');
    await tick();
    assert.strictEqual(goPaidMail(mf1) + goPaidMail(mf2), 0, 'manual_free never gets the go paid email');

    // 6. 7 day Whop trials keep the grace they had (row trial_end past, webhook not yet arrived).
    await expectKeepsAccess(port, 'whop.trial.mem@example.com', 'Whop trial with membership id', { meStatus: (seed('whop.trial.mem@example.com', { membership: 'mem_w1' }), 200) });
    await expectKeepsAccess(port, 'whop.trial.member@example.com', 'Whop trial with member id only', { meStatus: (seed('whop.trial.member@example.com', { member: 'user_w2' }), 200) });
    await expectKeepsAccess(port, 'whop.trial.shadow@example.com', 'Whop trial seen only by the shadow', { meStatus: (seed('whop.trial.shadow@example.com', { whopStatus: 'trialing' }), 200) });
    // Real Whop activation of a 7 day trial whose end has passed.
    const w4 = 'whop.trial.webhook@example.com';
    const act = await postWebhook(port, { type: 'membership.activated', data: { id: 'mem_w4', status: 'trialing', plan: { id: PLAN }, user: { email: w4 }, renewal_period_end: PAST } });
    assert.strictEqual(act.status, 200, 'Whop activation 200');
    assert.strictEqual(row(w4).status, 'trialing');
    await expectKeepsAccess(port, w4, 'Whop 7 day trial from the webhook');

    // 7. Stripe trials keep the same grace.
    seed('stripe.trial@example.com', { stripeCustomer: 'cus_t1' });
    await expectKeepsAccess(port, 'stripe.trial@example.com', 'Stripe trial with customer id');
    seed('stripe.trial.sub@example.com', { stripeSub: 'sub_t2' });
    await expectKeepsAccess(port, 'stripe.trial.sub@example.com', 'Stripe trial with subscription id');

    // 8. Paid users are untouched.
    seed('paid.active@example.com', { status: 'active', trialEnd: PAST, membership: 'mem_p1' });
    await expectKeepsAccess(port, 'paid.active@example.com', 'paid Whop active');
    seed('paid.active.nolink@example.com', { status: 'active', trialEnd: PAST });
    await expectKeepsAccess(port, 'paid.active.nolink@example.com', 'active with no billing link');
    seed('paid.free.notmf@example.com', { status: 'free', trialEnd: null });
    await expectKeepsAccess(port, 'paid.free.notmf@example.com', 'status free');
    seed('paid.canceled@example.com', { status: 'canceled', trialEnd: PAST, membership: 'mem_c1' });
    await expectKeepsAccess(port, 'paid.canceled@example.com', 'canceled stays cut off with no tester email', { meStatus: 403 });
    seed('paid.pastdue@example.com', { status: 'past_due', trialEnd: PAST, membership: 'mem_pd' });
    await expectKeepsAccess(port, 'paid.pastdue@example.com', 'past_due keeps its base requireAuth result', { meStatus: 403 });

    // 9. Unexpired testers keep access; a revoked tester gets no go paid email.
    seed('tester.unexpired@example.com', { trialEnd: FUTURE });
    await expectKeepsAccess(port, 'tester.unexpired@example.com', 'unexpired tester');
    seed('tester.revoked@example.com', { access: 0 });
    const rv = await me(port, 'tester.revoked@example.com');
    await tick();
    assert.strictEqual(rv.status, 403, 'revoked tester 403');
    assert.strictEqual(rv.json && rv.json.error, 'Account access has been revoked. Contact support.', 'revoked message unchanged');
    assert.strictEqual(goPaidMail('tester.revoked@example.com'), 0, 'revoked tester gets no go paid email');

    // 10. A tester with no trial_end at all is over, same as login already said.
    seed('tester.noend@example.com', { trialEnd: null });
    assert.strictEqual((await me(port, 'tester.noend@example.com')).status, 403, 'tester with no trial_end is cut off');

    // 11. An expired tester who pays through Whop gets access back and no second email.
    const t11 = 'tester.pays@example.com';
    seed(t11);
    assert.strictEqual((await me(port, t11)).status, 403);
    await tick();
    assert.strictEqual(goPaidMail(t11), 1);
    await postWebhook(port, { type: 'membership.activated', data: { id: 'mem_t11', status: 'active', plan: { id: PLAN }, user: { email: t11 }, renewal_period_end: FUTURE } });
    assert.strictEqual((await me(port, t11)).status, 200, 'paid former tester has access');
    assert.strictEqual(goPaidMail(t11), 1, 'no second go paid email after paying');

    // 12. Remove free (#37) on a tester shaped row: canceled, no mail of any kind.
    const rf = 'mf.removefree.tester@example.com';
    seed(rf, { manualFree: 1 });
    const from = captured.length;
    const cleared = await json(port, 'POST', '/api/admin/set-access', { email: rf, access_granted: true, manual_free: false }, { Authorization: 'Bearer ' + adminToken() });
    assert.strictEqual(cleared.status, 200, `Remove free 200 (got ${cleared.status} ${cleared.raw})`);
    assert.strictEqual(row(rf).status, 'canceled', 'Remove free still cancels a row with no live Whop membership');
    assert.strictEqual((await me(port, rf)).status, 403, 'Remove free cut off');
    await tick();
    assert.strictEqual(anyMail(rf, from), 0, 'Remove free sends no mail');

    // 14. Only the expired tester's own 403 carries code tester_expired; every other 403 body is byte for byte as before.
    const SUB = { error: 'Subscription required or trial expired.' };
    const REVOKED = { error: 'Account access has been revoked. Contact support.' };
    const LOGIN403 = { error: 'Account access has been revoked or trial expired.' };
    const t14 = 'tester.code@example.com';
    seed(t14);
    const own = await me(port, t14);
    assert.strictEqual(own.status, 403);
    assert.deepStrictEqual(own.json, { ...SUB, code: 'tester_expired' }, 'expired tester sees only the error and the code');
    assert.strictEqual(own.raw, JSON.stringify({ ...SUB, code: 'tester_expired' }), 'no other field on the expired tester 403');
    assert.deepStrictEqual((await login(port, t14)).json, LOGIN403, 'login 403 body unchanged, no code');
    assert.deepStrictEqual((await magic(port, t14)).json, LOGIN403, 'magic link 403 body unchanged, no code');
    const others = [
      ['code.canceled@example.com', { status: 'canceled' }, SUB],
      ['code.pastdue@example.com', { status: 'past_due' }, SUB],
      ['code.pending@example.com', { status: 'pending', access: 0 }, REVOKED],
      ['code.revoked.tester@example.com', { access: 0 }, REVOKED],
      ['code.revoked.canceled@example.com', { status: 'canceled', access: 0 }, REVOKED],
      ['code.revoked.whop@example.com', { access: 0, membership: 'mem_code_r' }, REVOKED],
      ['code.canceled.whop@example.com', { status: 'canceled', membership: 'mem_code_c', whopStatus: 'canceled' }, SUB],
      ['code.canceled.stripe@example.com', { status: 'canceled', stripeCustomer: 'cus_code', stripeSub: 'sub_code' }, SUB],
    ];
    for (const [email, opts, body] of others) {
      seed(email, opts);
      const r = await me(port, email);
      assert.strictEqual(r.status, 403, `${email}: 403`);
      assert.strictEqual(r.raw, JSON.stringify(body), `${email}: 403 body unchanged (got ${r.raw})`);
    }
    assert.strictEqual(row(rf).status, 'canceled');
    assert.strictEqual((await me(port, rf)).raw, JSON.stringify(SUB), 'Remove free canceled 403 body unchanged');
    const anon = await request(port, { method: 'GET', path: '/api/me' });
    assert.strictEqual(anon.raw, JSON.stringify({ error: 'Authentication required' }), 'no token: unchanged 401');
    const forged = await request(port, { method: 'GET', path: '/api/me', headers: { Authorization: 'Bearer ' + jwt.sign({ email: t14 }, 'not-the-secret') } });
    assert.ok(forged.status === 401 || forged.status === 403, 'forged token is refused');
    assert.ok(!forged.raw.includes('tester_expired'), 'a forged token for the tester never sees the code');
    const ghost = await me(port, 'nobody.code@example.com');
    assert.ok(!ghost.raw.includes('tester_expired'), 'unknown account never sees the code');
    await tick();

    // 15. The Account view shows the ended state from the code, and the subscribe link reaches paid checkout.
    const appHtml = (await request(port, { method: 'GET', path: '/app' })).raw;
    assert.strictEqual((appHtml.match(/data\.code === 'tester_expired'\) \{ showTesterEndedAccount\(emailEl, statusEl\); return; \}/g) || []).length, 2, 'both Account views branch on the code');
    assert.ok(appHtml.includes("link.href = '/#signup';") && appHtml.includes('Your tester access has ended.'), 'ended state links to the paid signup');
    assert.ok(appHtml.includes("link.textContent = 'Start my 7-day free trial';"), 'ended state button matches the trial button on the signup form');
    assert.ok(appHtml.includes("note.textContent = ' 7-day free trial, then $4.99 every 30 days or $39.99 every 365 days until you cancel. Cancel anytime in your Whop account.';"), 'ended state note states the trial, both renewal prices and how to cancel');
    assert.ok(!appHtml.includes('start your 7-day free trial with the same email address'), 'old ended state note is gone');
    assert.ok(!appHtml.includes('Subscribe to Pro') && !appHtml.includes('subscribe to Pro with the same email'), 'old subscribe wording is gone');
    const landing = (await request(port, { method: 'GET', path: '/' })).raw;
    const iSignup = landing.indexOf('id="signup"');
    const iTrial = landing.indexOf('id="trial-form"');
    const iTester = landing.indexOf('id="tester-signup-form"');
    assert.ok(iSignup > 0 && iSignup < iTrial && iTrial < iTester, '#signup opens with the paid trial form, before the tester form');
    const before = row(t14);
    const co = await json(port, 'POST', '/api/create-checkout', { email: t14, password: 'anything-8-chars', billing: 'monthly' });
    assert.strictEqual(co.status, 200, `paid checkout for the expired tester (got ${co.status} ${co.raw})`);
    assert.ok(co.json.url && co.json.url.startsWith('https://whop.com/checkout/test-plan') && co.json.provider === 'whop', 'expired tester is sent to Whop checkout');
    assert.strictEqual(new URL(co.json.url).searchParams.get('email'), t14, 'checkout carries the same email');
    assert.deepStrictEqual(row(t14), before, 'starting checkout does not change the tester row');

    // 13. /api/me body for an allowed tester has only the known fields. has_password is the
    // boolean the Account panel reads to hide Set Password; it never carries the hash.
    const meBody = (await me(port, 'tester.unexpired@example.com')).json;
    assert.deepStrictEqual(Object.keys(meBody).sort(), ['access_granted', 'email', 'has_password', 'manual_free', 'status', 'trial_end'], '/api/me fields');
    assert.strictEqual(meBody.has_password, true, '/api/me has_password is a plain boolean');

    const testerLog = captured.filter((l) => l.includes('[tester]'));
    assert.ok(testerLog.some((l) => /^\[tester\] go paid email sent for user \d+$/.test(l)), 'go paid sends are logged by user id');
    assert.ok(testerLog.every((l) => !/@/.test(l)), 'no email address in any tester expiry log line');
    console.log = origLog;
    console.log('lib/tester-expiry.test.js passed');
  } finally {
    console.log = origLog;
    await new Promise((resolve) => server.close(resolve));
    try { db.close(); } catch (e) {}
    cleanDb();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
