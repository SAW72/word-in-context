'use strict';
/**
 * Admin sign-in links: hashed single-use tokens, same access check as password login.
 * The admin page shows the link once and does not store it.
 */
const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

const dbFile = path.join(os.tmpdir(), `wic-admin-signin-${process.pid}.db`);
for (const extra of [dbFile, dbFile + '-wal', dbFile + '-shm']) {
  try { fs.unlinkSync(extra); } catch (e) {}
}

process.env.NODE_ENV = 'test';
process.env.WIC_DB_PATH = dbFile;
process.env.JWT_SECRET = 'unit-test-jwt-secret-at-least-32-chars';
process.env.ADMIN_PASSWORD = 'unit-test-admin-password';
process.env.TESTER_INVITE_TOKEN = 'unit-test-invite-token-32chars!!';
process.env.WHOP_CHECKOUT_URL_MONTHLY = '';
process.env.WHOP_CHECKOUT_URL_YEARLY = '';
process.env.XAI_API_KEY = '';
process.env.RESEND_API_KEY = '';
process.env.ADMIN_SIGNIN_LINK_RATE_MAX = '20';

const { app, db, adminSigninLinkLimiter } = require('../server');

const PASSWORD = 'password-ok-1';
const PASSWORD_HASH = bcrypt.hashSync(PASSWORD, 10);

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
      method: method || 'GET',
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

function extractFunction(src, name) {
  const start = src.indexOf('function ' + name);
  assert.ok(start >= 0, 'missing function ' + name);
  let depth = 0;
  for (let i = src.indexOf('{', start); i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') {
      depth--;
      if (depth === 0) return src.slice(start, i + 1);
    }
  }
  throw new Error('unclosed function ' + name);
}

function createEl(tag) {
  const el = {
    tag,
    id: '',
    className: '',
    children: [],
    parentNode: null,
    listeners: {},
    attrs: {},
    _text: '',
    set textContent(value) {
      el._text = value == null ? '' : String(value);
      el.children = [];
    },
    get textContent() {
      if (el.children.length) return el.children.map((child) => child.textContent).join('');
      return el._text;
    },
    setAttribute(name, value) {
      el.attrs[name] = String(value);
    },
    appendChild(child) {
      el._text = '';
      child.parentNode = el;
      el.children.push(child);
      return child;
    },
    removeChild(child) {
      const index = el.children.indexOf(child);
      if (index >= 0) el.children.splice(index, 1);
      child.parentNode = null;
      return child;
    },
    addEventListener(type, fn) {
      if (!el.listeners[type]) el.listeners[type] = [];
      el.listeners[type].push(fn);
    },
    removeAttribute(name) {
      delete el.attrs[name];
    },
    hasAttribute(name) {
      return Object.prototype.hasOwnProperty.call(el.attrs, name);
    },
    focus() {
      el.focused = true;
    },
    showModal() {
      el.open = true;
      el.modalShown = true;
    },
    close() {
      el.open = false;
      const fns = (el.listeners.close || []).slice();
      fns.forEach((fn) => fn());
    },
  };
  return el;
}

function walk(el, id) {
  if (!el) return null;
  if (el.id === id) return el;
  for (const child of el.children || []) {
    const found = walk(child, id);
    if (found) return found;
  }
  return null;
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function serialize(el) {
  if (el.tag === '#text') return escapeHtml(el.textContent);
  const inner = el.children.length
    ? el.children.map(serialize).join('')
    : escapeHtml(el.textContent);
  return '<' + el.tag + '>' + inner + '</' + el.tag + '>';
}

function countTag(el, tag) {
  let n = el.tag === tag ? 1 : 0;
  for (const child of el.children) n += countTag(child, tag);
  return n;
}

function findButton(el, text) {
  if (el.tag === 'button' && el.textContent === text) return el;
  for (const child of el.children) {
    const found = findButton(child, text);
    if (found) return found;
  }
  return null;
}

function insertUser({ email, status, trialEnd, access, manualFree, passwordHash }) {
  db.prepare(`
    INSERT INTO users (email, status, trial_end, access_granted, manual_free, password_hash)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(email, status, trialEnd || null, access, manualFree, passwordHash || null);
}

function accountFields(email) {
  return db.prepare(`
    SELECT access_granted, status, trial_end, manual_free
    FROM users WHERE email = ?
  `).get(email);
}

function userCount() {
  return db.prepare('SELECT COUNT(*) AS c FROM users').get().c;
}

function linkRows() {
  return db.prepare('SELECT * FROM admin_signin_links').all();
}

function sha256(value) {
  return crypto.createHash('sha256').update(String(value), 'utf8').digest('hex');
}

function tokenFromUrl(url) {
  return new URL(url).searchParams.get('admin_signin');
}

function assertNoStore(res, label) {
  const cache = String(res.headers['cache-control'] || '').toLowerCase();
  assert.ok(cache.includes('no-store'), label + ' Cache-Control is no-store, got ' + cache);
}

function testServiceWorkerSkipsTokenUrl() {
  const sw = fs.readFileSync(path.join(__dirname, '..', 'public', 'sw.js'), 'utf8');
  const nav = extractFunction(sw, 'navigationResponse');
  assert.ok(nav.includes("searchParams.has('admin_signin')"), 'navigation cache skips a URL that carries the admin token');
  assert.ok(nav.indexOf('cache.put') > nav.indexOf("searchParams.has('admin_signin')"), 'the token check guards cache.put');
}

function testLoginVerifySource() {
  const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'login-verify.js'), 'utf8');
  assert.ok(src.includes("url.searchParams.delete('admin_signin')"), 'the token is removed from the URL after redeem');
  assert.ok(src.includes('window.history.replaceState'), 'the login history entry drops the token');
  const redeemBranch = src.slice(src.indexOf('if (adminSignin)'));
  assert.ok(redeemBranch.indexOf('clearAdminSigninQuery()') < redeemBranch.indexOf('fetch('), 'the URL drops the token before the redeem request');
  assert.ok(!src.includes("localStorage.setItem('admin_signin'"), 'the raw token is not written to localStorage');
  assert.ok(!src.includes('localStorage.setItem("admin_signin"'), 'the raw token is not written to localStorage');
  assert.ok(!src.includes("localStorage.setItem('auth_token', adminSignin"), 'the raw token is not stored as the session');
  assert.ok(!src.includes('localStorage.setItem("auth_token", adminSignin'), 'the raw token is not stored as the session');
  assert.ok(!src.includes('innerHTML'), 'login script writes messages with textContent');
  assert.ok(src.includes('textContent'), 'login script writes messages with textContent');
  assert.ok(src.includes("document.title = 'Sign-in link not valid | The Word in Context'"));
  assert.ok(src.includes('This sign-in link was already used. If that was you, open the app. Otherwise ask for a new link.'));
  assert.ok(src.includes('This sign-in link is not valid. Ask for a new link, or sign in from the home page.'));
  assert.ok(src.includes('This sign-in link has expired. Ask for a new link, or sign in from the home page.'));
  assert.ok(src.includes("Your account doesn't have access right now. Your trial may have ended. Choose a plan to keep studying."));
  assert.ok(src.includes("We couldn't find an account for this link. Ask for a new link."));
  assert.ok(src.includes("We couldn't reach the server. Check your connection, then open the link again."));
  assert.ok(src.includes("setAttribute('role', 'alert')"));
  const sw = fs.readFileSync(path.join(__dirname, '..', 'public', 'sw.js'), 'utf8');
  assert.ok(sw.includes("CACHE_VERSION = 'wic-pwa-69'"), 'shell cache stays one above main');
  assert.ok(sw.includes("searchParams.has('admin_signin')"), 'the service worker does not cache a URL that holds the raw token');
}

function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

function sourceSlice(src, startMarker, endMarker) {
  const start = src.indexOf(startMarker);
  assert.ok(start >= 0, 'missing ' + startMarker);
  const end = src.indexOf(endMarker, start + startMarker.length);
  assert.ok(end > start, 'missing end after ' + startMarker);
  return src.slice(start, end);
}

function testRedeemGuards() {
  const src = stripComments(fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8'));
  const redeem = sourceSlice(src, "app.get('/api/admin-signin/redeem'", "app.get('/api/me'");
  const updateAt = redeem.indexOf('UPDATE admin_signin_links');
  assert.ok(updateAt >= 0, 'redeem updates the link row');
  const updateSql = redeem.slice(updateAt, redeem.indexOf('.run(', updateAt));
  assert.ok(/used_at\s+IS\s+NULL/.test(updateSql), 'single-use guard: the update matches only an unused row');
  assert.ok(/if\s*\(\s*spent\.changes\s*!==\s*1\s*\)/.test(redeem), 'single-use guard: a missed update is refused');
  assert.ok(/notifyIfExpiredTester\(user\)/.test(redeem), 'go paid email is sent from redeem');
  assert.ok(/record\.purpose\s*!==\s*'admin_signin'/.test(redeem), 'purpose check rejects any other purpose');
  const limiter = sourceSlice(src, "app.use('/api/admin/signin-link'", "app.use('/api/tester-signup'");
  assert.ok(
    limiter.includes("error: 'Too many sign-in links. Try again in 15 minutes.'"),
    'outer limiter returns the sign-in limit as JSON'
  );
}

function patchUser(email, fields) {
  const names = Object.keys(fields);
  db.prepare(
    'UPDATE users SET ' + names.map((name) => name + ' = ?').join(', ') + ' WHERE email = ?'
  ).run(...names.map((name) => fields[name]), email);
}

async function assertRedeemMatchesLogin(port, headers, email) {
  const before = accountFields(email);
  const login = await passwordLogin(port, email);
  const issued = await issue(port, headers, email);
  assert.strictEqual(issued.status, 200, email + ' issue ' + JSON.stringify(issued.json));
  const raw = tokenFromUrl(issued.json.url);
  const redeemed = await withLogs(() => redeem(port, raw));
  assert.strictEqual(redeemed.result.status, login.status, email + ' redeem status');
  if (login.status === 200) {
    assert.strictEqual(redeemed.result.json.email, email);
  } else {
    assert.strictEqual(redeemed.result.json.error, login.json.error, email + ' redeem error');
    assert.strictEqual(redeemed.result.json.code, 'no_access', email + ' redeem code');
  }
  assertLogsClean(redeemed.lines, [raw, sha256(raw), issued.json.url]);
  assert.deepStrictEqual(accountFields(email), before, email + ' access is unchanged');
  assertNoStore(redeemed.result, email);
  return login.status;
}

async function withLogs(fn) {
  const lines = [];
  const orig = {
    log: console.log,
    info: console.info,
    warn: console.warn,
    error: console.error,
  };
  const push = (args) => lines.push(args.map((part) => String(part)).join(' '));
  console.log = (...args) => push(args);
  console.info = (...args) => push(args);
  console.warn = (...args) => push(args);
  console.error = (...args) => push(args);
  try {
    const result = await fn();
    return { result, lines };
  } finally {
    console.log = orig.log;
    console.info = orig.info;
    console.warn = orig.warn;
    console.error = orig.error;
  }
}

function assertLogsClean(lines, secrets) {
  const blob = lines.join('\n');
  for (const secret of secrets) {
    assert.ok(secret, 'secret fixture is non-empty');
    assert.strictEqual(blob.indexOf(secret), -1, 'log leaked a sign-in secret');
  }
}

async function adminHeaders(port) {
  const login = await request(port, {
    method: 'POST',
    path: '/api/admin/login',
    body: { password: process.env.ADMIN_PASSWORD },
  });
  assert.strictEqual(login.status, 200, 'admin login');
  return { Authorization: 'Bearer ' + login.json.token };
}

async function issue(port, headers, email) {
  return request(port, {
    method: 'POST',
    path: '/api/admin/signin-link',
    headers,
    body: { email },
  });
}

async function redeem(port, rawToken) {
  return request(port, {
    method: 'GET',
    path: '/api/admin-signin/redeem?token=' + encodeURIComponent(rawToken),
  });
}

async function passwordLogin(port, email) {
  return request(port, {
    method: 'POST',
    path: '/api/login',
    body: { email, password: PASSWORD },
  });
}

function testAdminPage() {
  const adminHtml = fs.readFileSync(path.join(__dirname, '..', 'public', 'admin.html'), 'utf8');
  assert.ok(!adminHtml.includes('innerHTML'), 'admin page does not assign innerHTML');
  assert.ok(adminHtml.includes("mkBtn('Sign-in link'"), 'each user row can request a sign-in link');
  assert.ok(adminHtml.includes('id="signin-link-email"'), 'admin can type an existing email');
  assert.ok(adminHtml.includes('<label for="signin-link-email">Member email</label>'), 'the email input has a label');
  assert.ok(adminHtml.includes('id="signin-link-status" class="status" role="status" aria-live="polite"'));
  assert.ok(adminHtml.includes('overflow-wrap: anywhere'), 'long emails wrap in the dialog');
  assert.ok(adminHtml.includes("signinBtn.setAttribute('aria-label', 'Sign-in link for ' + u.email)"));
  assert.ok(adminHtml.includes("b.type = 'button'"));
  assert.ok(adminHtml.includes('data-signin-error'), 'a row has its own error slot');
  assert.ok(adminHtml.includes('requestAdminSigninLink(u.email, signinBtn)'));
  assert.ok(adminHtml.includes('Works once, expires in 24 hours.'), 'the panel states the limit');
  const reqSrc = extractFunction(adminHtml, 'requestAdminSigninLink');
  assert.ok(reqSrc.indexOf('r.status === 429') >= 0 && reqSrc.indexOf('r.status === 429') < reqSrc.indexOf('r.json()'), '429 is handled before r.json()');
  assert.ok(reqSrc.includes("'Too many sign-in links. Try again later.'"));
  assert.ok(reqSrc.includes('trigger.disabled = true') && reqSrc.includes('trigger.disabled = false'), 'the button is disabled while the request runs');
  assert.ok(reqSrc.indexOf('trigger.disabled = true') < reqSrc.indexOf('await fetch'), 'the button is disabled before the request');
  const writer = extractFunction(adminHtml, 'writeSigninMessage');
  assert.ok(writer.includes('el.textContent = text'), 'status and errors use textContent');
  assert.ok(writer.includes("setAttribute('role', 'alert')"));
  assert.ok(writer.includes("setAttribute('role', 'status')"));
  assert.ok(writer.includes("setAttribute('aria-live', 'polite')"));
  assert.ok(!writer.includes('innerHTML'));

  const names = ['closeAdminSigninLink', 'showAdminSigninLink', 'copyAdminSigninLink', 'requestAdminSigninLink'];
  const sources = names.map((name) => extractFunction(adminHtml, name));
  for (const src of sources) {
    assert.ok(!src.includes('localStorage'), 'sign-in link code does not touch localStorage');
    assert.ok(!src.includes('sessionStorage'), 'sign-in link code does not touch sessionStorage');
    assert.ok(!src.includes('console.'), 'sign-in link code does not log');
    assert.ok(!src.includes('document.title'), 'sign-in link code does not change the page title');
    assert.ok(!src.includes('innerHTML'), 'sign-in link code does not assign innerHTML');
    assert.ok(!src.includes('location'), 'sign-in link code does not write the page URL');
  }

  const body = createEl('body');
  const documentStub = {
    title: 'Admin',
    body,
    createElement: createEl,
    createTextNode(text) {
      const node = createEl('#text');
      node.textContent = text;
      return node;
    },
    getElementById(id) {
      return walk(body, id);
    },
  };
  const copied = [];
  const navigatorStub = {
    clipboard: {
      writeText(value) {
        copied.push(value);
        return Promise.resolve();
      },
    },
  };
  const api = new Function(
    'document',
    'navigator',
    sources.slice(0, 3).join('\n') + '\nreturn { closeAdminSigninLink, showAdminSigninLink, copyAdminSigninLink };'
  )(documentStub, navigatorStub);

  const hostileEmail = '<img src=x onerror=alert(1)>@church.org';
  const hostileUrl = 'https://evil.test/login?admin_signin=<script>alert(1)</script>';
  api.showAdminSigninLink(hostileEmail, hostileUrl);
  const panel = documentStub.getElementById('admin-signin-link-panel');
  assert.ok(panel, 'panel is in the document');
  assert.strictEqual(panel.tag, 'dialog', 'the panel is a native dialog');
  assert.strictEqual(panel.modalShown, true, 'the dialog opens with showModal');
  assert.strictEqual(panel.attrs['aria-labelledby'], 'admin-signin-link-title');
  const title = documentStub.getElementById('admin-signin-link-title');
  assert.ok(title && title.tag === 'h3', 'aria-labelledby points at the dialog h3');
  const copyNoteLive = documentStub.getElementById('admin-signin-link-copy-note');
  assert.strictEqual(copyNoteLive.attrs.role, 'status');
  assert.strictEqual(copyNoteLive.attrs['aria-live'], 'polite');
  const value = documentStub.getElementById('admin-signin-link-value');
  assert.strictEqual(value.textContent, hostileUrl);
  assert.ok(panel.textContent.includes(hostileEmail));
  assert.ok(panel.textContent.includes('Works once, expires in 24 hours.'));
  const html = serialize(panel);
  assert.ok(html.includes('&lt;img src=x onerror=alert(1)&gt;'), 'email is escaped text');
  assert.ok(html.includes('&lt;script&gt;alert(1)&lt;/script&gt;'), 'link is escaped text');
  assert.strictEqual(countTag(panel, 'img'), 0, 'panel does not create an img element');
  assert.strictEqual(countTag(panel, 'script'), 0, 'panel does not create a script element');
  assert.ok(!html.includes('<img'), 'serialized panel has no img tag');
  assert.ok(!html.includes('<script'), 'serialized panel has no script tag');
  assert.strictEqual(documentStub.title, 'Admin');

  const copyBtn = findButton(panel, 'Copy');
  assert.ok(copyBtn, 'Copy button is present');
  assert.strictEqual(copyBtn.focused, true, 'Copy is focused when the dialog opens');
  copyBtn.listeners.click[0]();
  return Promise.resolve().then(() => {
    assert.deepStrictEqual(copied, [hostileUrl], 'Copy writes only the link to the clipboard');
    const note = documentStub.getElementById('admin-signin-link-copy-note');
    assert.strictEqual(note.textContent, 'Copied.');
    api.closeAdminSigninLink();
    assert.strictEqual(documentStub.getElementById('admin-signin-link-panel'), null, 'closing removes the panel');
    assert.strictEqual(body.textContent.includes(hostileUrl), false, 'closing clears the link from the DOM');
    assert.strictEqual(body.textContent.includes(hostileEmail), false, 'closing clears the email from the panel');
    assert.strictEqual(documentStub.title, 'Admin');
    const opener = createEl('button');
    api.showAdminSigninLink('member@example.com', 'https://example.test/login?admin_signin=abc', opener);
    const again = documentStub.getElementById('admin-signin-link-panel');
    assert.strictEqual(again.tag, 'dialog');
    assert.strictEqual(again.openerButton, opener);
    api.closeAdminSigninLink();
    assert.strictEqual(opener.focused, true, 'closing returns focus to the button that opened the dialog');
    assert.strictEqual(documentStub.getElementById('admin-signin-link-panel'), null);
    return new Promise((resolve) => setTimeout(resolve, 0));
  });
}

async function main() {
  testServiceWorkerSkipsTokenUrl();
  testLoginVerifySource();
  testRedeemGuards();
  await testAdminPage();

  const { server, port } = await listen();
  try {
    adminSigninLinkLimiter.reset();
    const headers = await adminHeaders(port);
    const userJwt = jwt.sign({ email: 'member@example.com', id: 1 }, process.env.JWT_SECRET, { expiresIn: '1h' });

    const anon = await issue(port, {}, 'member@example.com');
    assert.strictEqual(anon.status, 401);
    assert.deepStrictEqual(anon.json, { error: 'Admin required' });

    const member = await issue(port, { Authorization: 'Bearer ' + userJwt }, 'member@example.com');
    assert.strictEqual(member.status, 401);
    assert.deepStrictEqual(member.json, { error: 'Admin required' });
    assert.strictEqual(linkRows().length, 0, 'a non-admin request stores nothing');

    const beforeUsers = userCount();
    const missing = await issue(port, headers, 'nobody@example.com');
    assert.strictEqual(missing.status, 404);
    assert.deepStrictEqual(missing.json, { error: 'No account for that email' });
    assert.strictEqual(userCount(), beforeUsers, 'unknown email does not create a user');
    assert.strictEqual(linkRows().length, 0, 'unknown email stores no link');

    const blank = await issue(port, headers, '   ');
    assert.strictEqual(blank.status, 400);
    assert.deepStrictEqual(blank.json, { error: 'Email required' });

    insertUser({
      email: 'active.user@example.com',
      status: 'active',
      access: 1,
      manualFree: 0,
      passwordHash: PASSWORD_HASH,
    });
    const activeBefore = accountFields('active.user@example.com');
    const magicBefore = db.prepare('SELECT COUNT(*) AS c FROM magic_tokens').get().c;

    const created = await withLogs(() => issue(port, headers, ' Active.User@Example.com '));
    assert.strictEqual(created.result.status, 200, JSON.stringify(created.result.json));
    assert.strictEqual(created.result.json.email, 'active.user@example.com');
    const raw = tokenFromUrl(created.result.json.url);
    assert.strictEqual(raw.length, 64, 'token is 32 bytes of hex');
    assert.ok(created.lines.some((line) => line === '[admin] signin link created for active.user@example.com expires ' + created.result.json.expires_at));
    assertLogsClean(created.lines, [raw, sha256(raw), created.result.json.url]);

    const expDelta = new Date(created.result.json.expires_at).getTime() - Date.now();
    assert.ok(expDelta > 23.9 * 60 * 60 * 1000 && expDelta < 24.1 * 60 * 60 * 1000, 'link expires in 24 hours');
    assert.deepStrictEqual(accountFields('active.user@example.com'), activeBefore, 'issuing a link does not change access');
    assert.strictEqual(db.prepare('SELECT COUNT(*) AS c FROM magic_tokens').get().c, magicBefore, 'admin links do not use the magic token table');

    const stored = db.prepare('SELECT * FROM admin_signin_links WHERE token_hash = ?').get(sha256(raw));
    assert.ok(stored, 'only the hash is stored');
    assert.strictEqual(stored.purpose, 'admin_signin');
    assert.strictEqual(stored.used_at, null);
    assert.strictEqual(stored.email, 'active.user@example.com');
    const storedBlob = JSON.stringify(linkRows());
    assert.strictEqual(storedBlob.indexOf(raw), -1, 'raw token is not in the sign-in table');
    assert.strictEqual(storedBlob.indexOf(created.result.json.url), -1, 'url is not in the sign-in table');
    assert.notStrictEqual(stored.token_hash, raw);

    const loginPage = await request(port, {
      method: 'GET',
      path: '/login?admin_signin=' + encodeURIComponent(raw),
    });
    assert.strictEqual(loginPage.status, 200);
    assert.ok(loginPage.raw.includes('src="/login-verify.js?v=3"'));
    assert.ok(loginPage.raw.includes('<h2>The Word in Context</h2>'));
    assert.ok(loginPage.raw.includes('id="login-msg" role="alert"'));
    assert.ok(loginPage.raw.includes('role="status"'));
    assert.strictEqual(loginPage.raw.indexOf(raw), -1, 'login HTML does not echo the token');

    const viaMagic = await request(port, {
      method: 'GET',
      path: '/api/verify-magic?token=' + encodeURIComponent(raw),
    });
    assert.strictEqual(viaMagic.status, 400, 'magic route does not accept an admin sign-in token');

    const first = await withLogs(() => redeem(port, raw));
    assert.strictEqual(first.result.status, 200, JSON.stringify(first.result.json));
    assert.strictEqual(first.result.json.email, 'active.user@example.com');
    assert.ok(first.result.json.token, 'redeem returns a session token');
    const session = jwt.verify(first.result.json.token, process.env.JWT_SECRET);
    assert.strictEqual(session.email, 'active.user@example.com');
    assert.strictEqual(JSON.stringify(session).indexOf(raw), -1);
    assert.ok(first.lines.some((line) => line === '[admin-signin] used by active.user@example.com'));
    assertLogsClean(first.lines, [raw, sha256(raw), created.result.json.url]);
    assert.deepStrictEqual(accountFields('active.user@example.com'), activeBefore, 'redeem does not change access');
    assert.ok(db.prepare('SELECT used_at FROM admin_signin_links WHERE token_hash = ?').get(sha256(raw)).used_at);
    assertNoStore(first.result, 'redeem');

    const second = await redeem(port, raw);
    assert.strictEqual(second.status, 400);
    assert.deepStrictEqual(second.json, { error: 'Invalid or expired token', code: 'link_used' });
    assertNoStore(second, 'second redeem');
    assert.strictEqual(JSON.stringify(second.json).indexOf(raw), -1, 'a refused redeem does not echo the token');
    assert.strictEqual(userCount(), beforeUsers + 1, 'redeem does not create a user');

    const secondLink = await issue(port, headers, 'active.user@example.com');
    const thirdLink = await issue(port, headers, 'active.user@example.com');
    assert.strictEqual(secondLink.status, 200);
    assert.strictEqual(thirdLink.status, 200);
    const rawB = tokenFromUrl(secondLink.json.url);
    const rawC = tokenFromUrl(thirdLink.json.url);
    assert.notStrictEqual(rawB, rawC);
    const useB = await redeem(port, rawB);
    const useC = await redeem(port, rawC);
    assert.strictEqual(useB.status, 200, 'an older unused link still works');
    assert.strictEqual(useC.status, 200, 'a newer link also works once');
    assert.strictEqual((await redeem(port, rawB)).status, 400);
    assert.strictEqual((await redeem(port, rawC)).status, 400);

    const parallelIssue = await issue(port, headers, 'active.user@example.com');
    assert.strictEqual(parallelIssue.status, 200);
    const parallelRaw = tokenFromUrl(parallelIssue.json.url);
    const parallelBefore = accountFields('active.user@example.com');
    const raced = await withLogs(() => Promise.all([redeem(port, parallelRaw), redeem(port, parallelRaw)]));
    const racedStatuses = raced.result.map((item) => item.status).sort();
    assert.deepStrictEqual(racedStatuses, [200, 400], 'one parallel redeem wins and the other loses');
    const racedOk = raced.result.find((item) => item.status === 200);
    const racedNo = raced.result.find((item) => item.status === 400);
    assert.strictEqual(racedOk.json.email, 'active.user@example.com');
    assert.deepStrictEqual(racedNo.json, { error: 'Invalid or expired token', code: 'link_used' });
    assert.strictEqual(JSON.stringify(raced.result).indexOf(parallelRaw), -1, 'parallel responses do not echo the token');
    assertLogsClean(raced.lines, [parallelRaw, sha256(parallelRaw), parallelIssue.json.url]);
    assert.deepStrictEqual(accountFields('active.user@example.com'), parallelBefore, 'parallel redeem does not change access');
    assert.ok(db.prepare('SELECT used_at FROM admin_signin_links WHERE token_hash = ?').get(sha256(parallelRaw)).used_at);
    assert.strictEqual((await redeem(port, parallelRaw)).status, 400, 'the raced token stays spent');

    const expiredIssue = await issue(port, headers, 'active.user@example.com');
    const expiredRaw = tokenFromUrl(expiredIssue.json.url);
    db.prepare(`UPDATE admin_signin_links SET expires_at = ? WHERE token_hash = ?`).run(
      new Date(Date.now() - 1000).toISOString(),
      sha256(expiredRaw)
    );
    const expired = await redeem(port, expiredRaw);
    assert.strictEqual(expired.status, 400);
    assert.deepStrictEqual(expired.json, { error: 'Invalid or expired token', code: 'link_expired' });
    assertNoStore(expired, 'expired redeem');
    assert.strictEqual(
      db.prepare('SELECT used_at FROM admin_signin_links WHERE token_hash = ?').get(sha256(expiredRaw)).used_at,
      null
    );

    insertUser({
      email: 'revoked.user@example.com',
      status: 'active',
      access: 0,
      manualFree: 0,
      passwordHash: PASSWORD_HASH,
    });
    const revokedBefore = accountFields('revoked.user@example.com');
    const revokedLogin = await passwordLogin(port, 'revoked.user@example.com');
    const revokedIssue = await issue(port, headers, 'revoked.user@example.com');
    const revokedRaw = tokenFromUrl(revokedIssue.json.url);
    const revokedRedeem = await redeem(port, revokedRaw);
    assert.strictEqual(revokedLogin.status, 403);
    assert.strictEqual(revokedRedeem.status, revokedLogin.status);
    assert.strictEqual(revokedRedeem.json.error, revokedLogin.json.error);
    assert.strictEqual(revokedRedeem.json.code, 'no_access');
    assert.ok(
      db.prepare('SELECT used_at FROM admin_signin_links WHERE token_hash = ?').get(sha256(revokedRaw)).used_at,
      'a refused redeem uses up the link'
    );
    assert.deepStrictEqual(accountFields('revoked.user@example.com'), revokedBefore);

    const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    insertUser({
      email: 'expired.trial@example.com',
      status: 'trialing',
      trialEnd: yesterday,
      access: 1,
      manualFree: 0,
      passwordHash: PASSWORD_HASH,
    });
    const trialBefore = accountFields('expired.trial@example.com');
    const trialLogin = await passwordLogin(port, 'expired.trial@example.com');
    const trialIssue = await issue(port, headers, 'expired.trial@example.com');
    const trialRedeem = await redeem(port, tokenFromUrl(trialIssue.json.url));
    assert.strictEqual(trialLogin.status, 403);
    assert.deepStrictEqual(trialLogin.json, { error: 'Account access has been revoked or trial expired.' });
    assert.strictEqual(trialRedeem.status, trialLogin.status);
    assert.strictEqual(trialRedeem.json.error, trialLogin.json.error);
    assert.strictEqual(trialRedeem.json.code, 'no_access');
    assert.deepStrictEqual(accountFields('expired.trial@example.com'), trialBefore);

    insertUser({
      email: 'manual.free@example.com',
      status: 'trialing',
      trialEnd: yesterday,
      access: 1,
      manualFree: 1,
      passwordHash: PASSWORD_HASH,
    });
    const freeBefore = accountFields('manual.free@example.com');
    const freeLogin = await passwordLogin(port, 'manual.free@example.com');
    const freeIssue = await issue(port, headers, 'manual.free@example.com');
    const freeRedeem = await redeem(port, tokenFromUrl(freeIssue.json.url));
    assert.strictEqual(freeLogin.status, 200);
    assert.strictEqual(freeRedeem.status, 200);
    assert.strictEqual(freeRedeem.json.email, 'manual.free@example.com');
    assert.deepStrictEqual(accountFields('manual.free@example.com'), freeBefore);

    insertUser({
      email: 'closed.past.due@example.com',
      status: 'past_due',
      access: 1,
      manualFree: 0,
      passwordHash: PASSWORD_HASH,
    });
    assert.strictEqual(await assertRedeemMatchesLogin(port, headers, 'closed.past.due@example.com'), 403);

    insertUser({
      email: 'whop.past.due@example.com',
      status: 'past_due',
      access: 1,
      manualFree: 0,
      passwordHash: PASSWORD_HASH,
    });
    patchUser('whop.past.due@example.com', {
      whop_status: 'past_due',
      whop_membership_id: 'mem_1',
      whop_event_at: new Date().toISOString(),
    });
    assert.strictEqual(await assertRedeemMatchesLogin(port, headers, 'whop.past.due@example.com'), 200);

    insertUser({
      email: 'whop.past.grace@example.com',
      status: 'past_due',
      access: 1,
      manualFree: 0,
      passwordHash: PASSWORD_HASH,
    });
    patchUser('whop.past.grace@example.com', {
      whop_status: 'past_due',
      whop_membership_id: 'mem_1',
      whop_event_at: new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString(),
    });
    assert.strictEqual(await assertRedeemMatchesLogin(port, headers, 'whop.past.grace@example.com'), 403);

    insertUser({
      email: 'stripe.past.due@example.com',
      status: 'past_due',
      access: 1,
      manualFree: 0,
      passwordHash: PASSWORD_HASH,
    });
    patchUser('stripe.past.due@example.com', { stripe_customer_id: 'cus_1' });
    assert.strictEqual(await assertRedeemMatchesLogin(port, headers, 'stripe.past.due@example.com'), 200);

    insertUser({
      email: 'magic.user@example.com',
      status: 'active',
      access: 1,
      manualFree: 0,
    });
    const magicToken = crypto.randomBytes(32).toString('hex');
    db.prepare('INSERT INTO magic_tokens (token, email, expires_at) VALUES (?, ?, ?)').run(
      magicToken,
      'magic.user@example.com',
      new Date(Date.now() + 15 * 60 * 1000).toISOString()
    );
    const magicOk = await request(port, {
      method: 'GET',
      path: '/api/verify-magic?token=' + encodeURIComponent(magicToken),
    });
    assert.strictEqual(magicOk.status, 200, 'existing 15 minute magic links still sign in');
    assert.strictEqual(magicOk.json.email, 'magic.user@example.com');
    const magicAgain = await request(port, {
      method: 'GET',
      path: '/api/verify-magic?token=' + encodeURIComponent(magicToken),
    });
    assert.strictEqual(magicAgain.status, 400, 'a used magic link is still refused');

    const garbage = await redeem(port, crypto.randomBytes(32).toString('hex'));
    assert.strictEqual(garbage.status, 400);
    assert.deepStrictEqual(garbage.json, { error: 'Invalid or expired token', code: 'link_invalid' });

    const nanIssue = await issue(port, headers, 'active.user@example.com');
    assert.strictEqual(nanIssue.status, 200);
    const nanRaw = tokenFromUrl(nanIssue.json.url);
    db.prepare('UPDATE admin_signin_links SET expires_at = ? WHERE token_hash = ?').run('not-a-date', sha256(nanRaw));
    const nanRedeem = await redeem(port, nanRaw);
    assert.strictEqual(nanRedeem.status, 400, 'a NaN expiry is refused');
    assert.deepStrictEqual(nanRedeem.json, { error: 'Invalid or expired token', code: 'link_expired' });
    assert.strictEqual(
      db.prepare('SELECT used_at FROM admin_signin_links WHERE token_hash = ?').get(sha256(nanRaw)).used_at,
      null,
      'a NaN expiry is refused before the link is spent'
    );

    const otherRaw = crypto.randomBytes(32).toString('hex');
    db.prepare(`
      INSERT INTO admin_signin_links (token_hash, email, created_at, expires_at, used_at, purpose)
      VALUES (?, ?, ?, ?, NULL, ?)
    `).run(
      sha256(otherRaw),
      'active.user@example.com',
      new Date().toISOString(),
      new Date(Date.now() + 60 * 60 * 1000).toISOString(),
      'other'
    );
    const otherRedeem = await redeem(port, otherRaw);
    assert.strictEqual(otherRedeem.status, 400, 'a different purpose is refused');
    assert.deepStrictEqual(otherRedeem.json, { error: 'Invalid or expired token', code: 'link_invalid' });
    assert.strictEqual(
      db.prepare('SELECT used_at FROM admin_signin_links WHERE token_hash = ?').get(sha256(otherRaw)).used_at,
      null,
      'a different purpose is refused before the link is spent'
    );

    insertUser({
      email: 'gone.user@example.com',
      status: 'active',
      access: 1,
      manualFree: 0,
      passwordHash: PASSWORD_HASH,
    });
    const goneIssue = await issue(port, headers, 'gone.user@example.com');
    assert.strictEqual(goneIssue.status, 200);
    const goneRaw = tokenFromUrl(goneIssue.json.url);
    db.prepare('DELETE FROM users WHERE email = ?').run('gone.user@example.com');
    const goneRedeem = await redeem(port, goneRaw);
    assert.strictEqual(goneRedeem.status, 401);
    assert.deepStrictEqual(goneRedeem.json, { error: 'No account with that email', code: 'no_account' });
    assert.ok(
      db.prepare('SELECT used_at FROM admin_signin_links WHERE token_hash = ?').get(sha256(goneRaw)).used_at,
      'a refused redeem uses up the link'
    );

    const goPaidEmail = 'tester.redeem.gopaid@example.com';
    insertUser({
      email: goPaidEmail,
      status: 'trialing',
      trialEnd: new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString(),
      access: 1,
      manualFree: 0,
      passwordHash: PASSWORD_HASH,
    });
    const goPaidIssue = await issue(port, headers, goPaidEmail);
    assert.strictEqual(goPaidIssue.status, 200);
    const goPaidRaw = tokenFromUrl(goPaidIssue.json.url);
    const goPaid = await withLogs(async () => {
      const result = await redeem(port, goPaidRaw);
      await new Promise((resolve) => setImmediate(resolve));
      return result;
    });
    assert.strictEqual(goPaid.result.status, 403);
    assert.strictEqual(goPaid.result.json.code, 'no_access');
    assert.ok(
      goPaid.lines.some((line) => line.includes('[WHOP EMAIL to ' + goPaidEmail + '] Your tester access has ended. Start your free trial of The Word in Context')),
      'redeem sends the go paid email'
    );
    assert.ok(
      db.prepare('SELECT tester_expired_email_at FROM users WHERE email = ?').get(goPaidEmail).tester_expired_email_at,
      'redeem claims the go paid email'
    );
    assert.ok(
      db.prepare('SELECT used_at FROM admin_signin_links WHERE token_hash = ?').get(sha256(goPaidRaw)).used_at,
      'a refused redeem uses up the link'
    );

    adminSigninLinkLimiter.reset();
    let last = null;
    for (let i = 0; i < 20; i++) {
      last = await issue(port, headers, 'active.user@example.com');
      assert.strictEqual(last.status, 200, 'issue ' + (i + 1) + ' status ' + last.status);
    }
    const limited = await issue(port, headers, 'active.user@example.com');
    assert.strictEqual(limited.status, 429);
    assert.deepStrictEqual(limited.json, { error: 'Too many sign-in links. Try again later.' });

    console.log('lib/admin-signin-link.test.js passed');
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
