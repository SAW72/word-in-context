'use strict';
/**
 * Login, success, and share pages read query values from static scripts.
 * The HTML response must not include those request values.
 */
const assert = require('assert');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

const dbFile = path.join(os.tmpdir(), `wic-login-page-${process.pid}.db`);
for (const extra of [dbFile, dbFile + '-wal', dbFile + '-shm']) {
  try { fs.unlinkSync(extra); } catch (e) {}
}

process.env.NODE_ENV = 'test';
process.env.WIC_DB_PATH = dbFile;
process.env.JWT_SECRET = 'unit-test-jwt-secret-at-least-32-chars';
process.env.ADMIN_PASSWORD = 'unit-test-admin-password';
process.env.WHOP_CHECKOUT_URL_MONTHLY = '';
process.env.WHOP_CHECKOUT_URL_YEARLY = '';
process.env.STRIPE_SECRET_KEY = '';
process.env.STRIPE_PRICE_ID = '';

const { app, db } = require('../server');

function listen() {
  return new Promise((resolve) => {
    const server = http.createServer(app);
    server.listen(0, '127.0.0.1', () => {
      resolve({ server, port: server.address().port });
    });
  });
}

function request(port, urlPath, headers) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: '127.0.0.1',
      port,
      method: 'GET',
      path: urlPath,
      headers: headers || {},
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        resolve({ status: res.statusCode, raw: Buffer.concat(chunks).toString('utf8') });
      });
    });
    req.on('error', reject);
    req.end();
  });
}

function assertAbsent(raw, value, label) {
  assert.ok(value, label + ' fixture is non-empty');
  assert.strictEqual(raw.indexOf(value), -1, label + ' must not appear in the HTML');
}

async function main() {
  const loginSrc = fs.readFileSync(path.join(__dirname, '..', 'public', 'login-verify.js'), 'utf8');
  const successSrc = fs.readFileSync(path.join(__dirname, '..', 'public', 'success-checkout.js'), 'utf8');
  const shareSrc = fs.readFileSync(path.join(__dirname, '..', 'public', 'share-redirect.js'), 'utf8');

  assert.match(loginSrc, /new URLSearchParams\(location\.search\)\.get\('token'\)/);
  assert.match(loginSrc, /fetch\('\/api\/verify-magic\?token=' \+ encodeURIComponent\(token\)\)/);
  assert.match(loginSrc, /localStorage\.setItem\('auth_token', data\.token\)/);
  assert.match(loginSrc, /localStorage\.setItem\('user_email', data\.email \|\| ''\)/);
  assert.match(loginSrc, /window\.location\.href = '\/app'/);
  assert.ok(loginSrc.includes("Login failed: ' + (data.error || 'unknown')"));
  assert.ok(loginSrc.includes('Login error. Try the link again'));

  assert.match(successSrc, /new URLSearchParams\(location\.search\)/);
  assert.match(successSrc, /params\.get\('session_id'\)/);
  assert.match(successSrc, /params\.get\('email'\)/);
  assert.ok(successSrc.includes("fetch('/api/complete-checkout'"));
  assert.ok(successSrc.includes('Account ready. Check your email or log in with your password.'));
  assert.ok(successSrc.includes('Account ready. Use the Log in button at the top with your email + password, or request a magic link.'));
  assert.ok(successSrc.includes('Use the Log in button at the top with your email + password, or request a magic link.'));
  assert.ok(successSrc.includes("sessionStorage.getItem('wic_checkout_email')"));

  assert.match(shareSrc, /window\.location\.replace\('\/app'\)/);
  assert.ok(!shareSrc.includes('location.search'), 'share redirect does not read the request');

  const sample = 'abc\'"<>/</script><script>alert(1)</script>';
  const fromQuery = new URLSearchParams('token=' + encodeURIComponent(sample)).get('token');
  const encodedUrl = '/api/verify-magic?token=' + encodeURIComponent(fromQuery);
  assert.strictEqual(fromQuery, sample);
  assert.ok(!encodedUrl.includes('</script>'), 'encoded token must not contain a raw script closer');
  assert.ok(!encodedUrl.includes('<'), 'encoded token must not contain a raw angle bracket');
  assert.ok(!encodedUrl.includes('"'), 'encoded token must not contain a raw double quote');
  assert.ok(encodedUrl.includes('%3C'), 'angle brackets are percent-encoded');
  assert.ok(encodedUrl.includes(encodeURIComponent(sample)));

  const { server, port } = await listen();
  try {
    const missing = await request(port, '/login');
    assert.strictEqual(missing.status, 200);
    assert.strictEqual(missing.raw, '<p>No token provided. <a href="/">Go to The Word in Context</a></p>');
    assert.ok(!missing.raw.includes('<script'), 'missing-token page has no script');

    const login = await request(port, '/login?token=' + encodeURIComponent(sample));
    assert.strictEqual(login.status, 200);
    assert.ok(login.raw.includes('src="/login-verify.js"'), 'login page loads the static script');
    assert.ok(login.raw.includes('Verifying your login link...'));
    assertAbsent(login.raw, sample, 'login token');
    assert.ok(!login.raw.includes('</script><script>'), 'login HTML must not contain a script breakout');
    assert.ok(!login.raw.includes('verify-magic'), 'login HTML must not build the verify URL');
    assert.ok(!login.raw.includes('fetch('), 'login HTML must not inline the verify call');

    const sessionId = 'cs_\'"</script><script>alert(2)</script>';
    const email = 'User\'"<tag>@Example.com</script>';
    const success = await request(
      port,
      '/success?session_id=' + encodeURIComponent(sessionId) + '&email=' + encodeURIComponent(email)
    );
    assert.strictEqual(success.status, 200);
    assert.ok(success.raw.includes('src="/success-checkout.js"'), 'success page loads the static script');
    assert.ok(
      success.raw.includes('data-payment-provider="stripe"') || success.raw.includes('data-payment-provider="whop"'),
      'payment provider attribute is a fixed label'
    );
    assertAbsent(success.raw, sessionId, 'session id');
    assertAbsent(success.raw, email, 'email');
    assertAbsent(success.raw, email.toLowerCase(), 'normalized email');
    assert.ok(!success.raw.includes('</script><script>'), 'success HTML must not contain a script breakout');
    assert.ok(!success.raw.includes('complete-checkout'), 'success HTML must not inline the checkout call');

    const shareId = 'a"</script>\'<>';
    assert.ok(shareId.length <= 32);
    db.prepare('INSERT INTO shares (id, type, payload) VALUES (?, ?, ?)').run(
      shareId,
      'verse',
      JSON.stringify({ type: 'verse', reference: 'John 1:1', translation: 'BSB', text: 'In the beginning' })
    );
    const sharePath = '/share/' + encodeURIComponent(shareId);
    const share = await request(port, sharePath);
    assert.strictEqual(share.status, 200, 'share page status ' + share.status + ' body ' + share.raw.slice(0, 200));
    assert.ok(share.raw.includes('src="/share-redirect.js"'), 'share page loads the static redirect');
    assertAbsent(share.raw, shareId, 'share id');
    assert.ok(share.raw.includes('&quot;&lt;/script&gt;&#39;&lt;&gt;') || share.raw.includes('&quot;&lt;/script&gt;'), 'share id is escaped when it appears in a URL');
    assert.ok(!share.raw.includes('setTimeout'), 'share HTML must not inline the redirect');

    const crawler = await request(port, sharePath, { 'User-Agent': 'facebookexternalhit/1.1' });
    assert.strictEqual(crawler.status, 200);
    assert.ok(!crawler.raw.includes('share-redirect.js'), 'crawler response has no redirect script');
    assert.ok(!crawler.raw.includes('<script'), 'crawler response has no script');
    assertAbsent(crawler.raw, shareId, 'crawler share id');

    console.log('lib/login-page.test.js passed');
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
