'use strict';
/**
 * TwicIOS Study page variant. Browser bytes stay the file on disk.
 * The iOS response drops price, trial, subscribe, and Whop/Stripe copy.
 *
 * Allowlist removed before the commerce regexes. Each entry is code, not copy:
 * - subscribe-modal: id and CSS for the Account/login modal. Login must stay.
 * - beta_subscribed: legacy localStorage key. It is never shown as text.
 * - $1 and $3: String.replace backreferences in verse cleanup, not prices.
 *   A real price such as $4.99 still matches /\$\d/ after these are removed.
 * TRIAL_DAYS, trialDays, trial_end, and testerTrialDays are not listed.
 * Word-boundary "trial" does not match them, and the visible trial sentences
 * are inside omit regions. tester-ended-subscribe is omitted, not allowlisted.
 */
const assert = require('assert');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const vm = require('vm');
const { isTwicIOS, renderTwicIOSPage } = require('./twic-ios-page');
const { CACHE_PRIVATE, cacheControlForPath } = require('./http-cache');

const ALLOWLIST = ['subscribe-modal', 'beta_subscribed', '$1', '$3'];
const IOS_UA = 'Mozilla/5.0 (iPhone) TwicIOS/1.0';
const SAFARI_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';

assert.strictEqual(isTwicIOS(IOS_UA), true);
assert.strictEqual(isTwicIOS('TwicIOS/1.0'), true);
assert.strictEqual(isTwicIOS('prefix TwicIOS suffix'), true);
assert.strictEqual(isTwicIOS(SAFARI_UA), false, 'plain iPhone Safari is not the app');
assert.strictEqual(isTwicIOS(''), false);
assert.strictEqual(isTwicIOS(null), false);
assert.strictEqual(isTwicIOS(undefined), false);
assert.strictEqual(isTwicIOS('NotTwicIOS'), false);
assert.strictEqual(isTwicIOS('TwicIOSExtra'), false);

assert.strictEqual(
  renderTwicIOSPage('A<!-- twic-ios-omit:start -->PRICE<!-- twic-ios-alt:\nFREE\n--><!-- twic-ios-omit:end -->B'),
  'AFREE\nB'
);
assert.strictEqual(
  renderTwicIOSPage('A<!-- twic-ios-omit:start -->GONE<!-- twic-ios-omit:end -->B'),
  'AB'
);
const jsSample = 'var x=1;/* twic-ios-omit:start */x=2;/* twic-ios-alt:\nx=3;\n*//* twic-ios-omit:end */';
const jsOut = renderTwicIOSPage(jsSample);
assert.ok(jsOut.includes('x=3'));
assert.ok(!jsOut.includes('x=2'));
new vm.Script(jsOut);

assert.strictEqual(cacheControlForPath('/index.html', { isProduction: true }), CACHE_PRIVATE);
assert.strictEqual(cacheControlForPath('/app', { isProduction: true }), CACHE_PRIVATE);
assert.ok(CACHE_PRIVATE.includes('no-store'));

const dbFile = path.join(os.tmpdir(), `wic-twic-ios-${process.pid}.db`);
for (const extra of [dbFile, dbFile + '-wal', dbFile + '-shm']) {
  try { fs.unlinkSync(extra); } catch (e) {}
}
process.env.NODE_ENV = 'test';
process.env.WIC_DB_PATH = dbFile;
process.env.JWT_SECRET = 'unit-test-jwt-secret-at-least-32-chars';
process.env.ADMIN_PASSWORD = 'unit-test-admin-password';
process.env.XAI_API_KEY = '';
process.env.RESEND_API_KEY = '';
process.env.STRIPE_SECRET_KEY = '';
process.env.WHOP_API_KEY = 'test-whop-key-not-real';
process.env.WHOP_API_BASE_URL = 'http://127.0.0.1:9';

const { app, db } = require('../server');
const filePath = path.join(__dirname, '..', 'public', 'index.html');
const fileBytes = fs.readFileSync(filePath);
const fileText = fileBytes.toString('utf8');

function listen() {
  return new Promise((resolve) => {
    const server = http.createServer(app);
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

function get(port, urlPath, ua) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: '127.0.0.1',
      port,
      method: 'GET',
      path: urlPath,
      headers: { 'User-Agent': ua },
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({
        status: res.statusCode,
        headers: res.headers,
        body: Buffer.concat(chunks),
      }));
    });
    req.on('error', reject);
    req.end();
  });
}

function headerValue(headers, name) {
  const value = headers[name.toLowerCase()];
  if (Array.isArray(value)) return value.join(', ');
  return value == null ? '' : String(value);
}

function compileInline(label, html) {
  const scripts = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)]
    .filter((match) => !/\bsrc\s*=/i.test(match[1]));
  assert.ok(scripts.length >= 1, label + ' has an inline script');
  for (const match of scripts) {
    try {
      new vm.Script(match[2]);
    } catch (err) {
      assert.fail(label + ' inline script failed to compile: ' + err.message);
    }
  }
}

function assertIosClean(body) {
  let stripped = body;
  for (const token of ALLOWLIST) stripped = stripped.split(token).join('');
  const checks = [
    [/\$\d/, 'price digit'],
    [/whop/i, 'whop'],
    [/stripe/i, 'stripe'],
    [/free trial/i, 'free trial'],
    [/\d+-day trial/i, 'day trial'],
    [/#signup/, '#signup'],
    [/\/checkout/, '/checkout'],
    [/\btrial\b/i, 'trial word'],
    [/subscri/i, 'subscribe'],
  ];
  for (const [re, label] of checks) {
    const hit = stripped.match(re);
    assert.ok(!hit, 'iOS body still has ' + label + (hit ? ': ' + stripped.slice(Math.max(0, hit.index - 40), hit.index + 40) : ''));
  }
}

async function main() {
  assert.ok(fileText.includes('Start my 7-day free trial'), 'commerce copy stays in the file for browsers');
  assert.ok(fileText.includes('$4.99'), 'price stays in the file for browsers');
  assert.ok(fileText.includes('tester-ended-subscribe'), 'tester-ended link stays in the file');

  const { server, port } = await listen();
  try {
    for (const urlPath of ['/app', '/index.html']) {
      const browser = await get(port, urlPath, SAFARI_UA);
      const ios = await get(port, urlPath, IOS_UA);
      assert.strictEqual(browser.status, 200, urlPath + ' browser status');
      assert.strictEqual(ios.status, 200, urlPath + ' ios status');
      assert.ok(browser.body.equals(fileBytes), urlPath + ' browser body is the file bytes');
      assert.ok(!ios.body.equals(fileBytes), urlPath + ' ios body differs from the file');

      for (const res of [browser, ios]) {
        const vary = headerValue(res.headers, 'vary');
        assert.ok(/user-agent/i.test(vary), urlPath + ' Vary includes User-Agent, got ' + vary);
        const cache = headerValue(res.headers, 'cache-control');
        assert.ok(/no-store/i.test(cache), urlPath + ' Cache-Control is no-store, got ' + cache);
      }

      const iosText = ios.body.toString('utf8');
      assertIosClean(iosText);
      assert.ok(iosText.includes('id="delete-account-btn"'), urlPath + ' keeps Delete account');
      assert.ok(iosText.includes('id="login-section"'), urlPath + ' keeps the login form');
      assert.ok(iosText.includes('id="modal-login-email"'), urlPath + ' keeps the login email field');
      assert.ok(iosText.includes('id="subscribe-modal"'), urlPath + ' keeps the Account modal');
      assert.ok(!iosText.includes('tester-ended-subscribe'), urlPath + ' omits the trial subscribe link');
      assert.ok(!iosText.includes('#signup'), urlPath + ' omits signup links');
      compileInline(urlPath + ' ios', iosText);
      compileInline(urlPath + ' browser', browser.body.toString('utf8'));
    }

    const appBrowser = await get(port, '/app', SAFARI_UA);
    const indexBrowser = await get(port, '/index.html', SAFARI_UA);
    assert.ok(appBrowser.body.equals(indexBrowser.body));
    assert.strictEqual(headerValue(appBrowser.headers, 'x-robots-tag'), 'noindex, follow');
    assert.strictEqual(headerValue(indexBrowser.headers, 'x-robots-tag'), '', '/index.html stays robots-untagged');

    console.log('twic-ios-page tests passed');
  } finally {
    await new Promise((resolve) => server.close(resolve));
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
