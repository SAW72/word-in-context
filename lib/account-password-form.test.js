'use strict';
/**
 * Drives public/index.html in headless Chrome.
 * Source-string checks do not count: the button is clicked and the DOM is read back.
 */
const assert = require('assert');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const jwt = require('jsonwebtoken');

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const SECRET = 'account-form-test-secret-at-least-32';
const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const SET_HELP = 'Set a password (min 8 chars)';
const CHANGE_HELP = 'Change Password (min 8 characters). Enter your current password, then the new one.';

function staticServer() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const url = new URL(req.url, 'http://127.0.0.1');
      let rel = decodeURIComponent(url.pathname);
      if (rel === '/') rel = '/index.html';
      const file = path.normalize(path.join(PUBLIC_DIR, rel));
      if (!file.startsWith(PUBLIC_DIR)) {
        res.writeHead(403);
        res.end();
        return;
      }
      fs.readFile(file, (err, buf) => {
        if (err) {
          res.writeHead(404);
          res.end('missing');
          return;
        }
        const types = {
          '.html': 'text/html; charset=utf-8',
          '.js': 'text/javascript; charset=utf-8',
          '.css': 'text/css; charset=utf-8',
          '.svg': 'image/svg+xml',
          '.json': 'application/json',
          '.webmanifest': 'application/manifest+json',
          '.png': 'image/png',
        };
        res.writeHead(200, { 'Content-Type': types[path.extname(file)] || 'application/octet-stream' });
        res.end(buf);
      });
    });
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

function freePort() {
  return new Promise((resolve) => {
    const probe = http.createServer();
    probe.listen(0, '127.0.0.1', () => {
      const port = probe.address().port;
      probe.close(() => resolve(port));
    });
  });
}

function waitForJson(port) {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const tick = () => {
      const req = http.get('http://127.0.0.1:' + port + '/json/version', (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
          catch (err) { reject(err); }
        });
      });
      req.on('error', () => {
        if (Date.now() - started > 8000) reject(new Error('Chrome DevTools did not open'));
        else setTimeout(tick, 50);
      });
    };
    tick();
  });
}

function openSocket(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    ws.addEventListener('open', () => resolve(ws));
    ws.addEventListener('error', () => reject(new Error('Chrome socket failed')));
  });
}

function cdp(ws) {
  let next = 0;
  const pending = new Map();
  ws.addEventListener('message', (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) {
      pending.get(msg.id)(msg);
      pending.delete(msg.id);
    }
  });
  return function send(method, params) {
    const id = ++next;
    return new Promise((resolve) => {
      pending.set(id, resolve);
      ws.send(JSON.stringify({ id, method, params: params || {} }));
    });
  };
}

async function evaluate(send, expression) {
  const msg = await send('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true,
  });
  const details = msg.result && msg.result.exceptionDetails;
  if (details) {
    const text = details.exception && details.exception.description
      ? details.exception.description
      : details.text;
    throw new Error(text || 'page eval failed');
  }
  return msg.result.result.value;
}

function signToken(expiresIn) {
  return jwt.sign({ email: 'buyer@example.com', purpose: 'set-password' }, SECRET, { expiresIn });
}

async function main() {
  assert.ok(fs.existsSync(CHROME), 'headless Chrome is required to drive the account page');
  const live = signToken('15m');
  const expired = signToken('-10s');
  const server = await staticServer();
  const pageUrl = 'http://127.0.0.1:' + server.address().port + '/index.html';
  const port = await freePort();
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'wic-account-form-'));
  const chrome = spawn(CHROME, [
    '--headless=new',
    '--disable-gpu',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-extensions',
    '--disable-sync',
    '--remote-debugging-port=' + port,
    '--user-data-dir=' + profile,
    'about:blank',
  ], { detached: true, stdio: 'ignore' });
  chrome.unref();

  let browserWs;
  let pageWs;
  try {
    const version = await waitForJson(port);
    browserWs = await openSocket(version.webSocketDebuggerUrl);
    const browser = cdp(browserWs);
    const created = await browser('Target.createTarget', { url: pageUrl });
    const list = await browser('Target.getTargets');
    const page = (list.result.targetInfos || []).find((t) => t.targetId === created.result.targetId);
    assert.ok(page, 'Chrome did not open the account page');
    pageWs = await openSocket('ws://127.0.0.1:' + port + '/devtools/page/' + page.targetId);
    const send = cdp(pageWs);
    await send('Runtime.enable');
    const ready = Date.now();
    let booted = false;
    while (Date.now() - ready < 15000) {
      booted = await evaluate(send, "document.readyState === 'complete' && typeof syncSetPasswordForm === 'function' && typeof addPasswordToggles === 'function'");
      if (booted) break;
      await new Promise((r) => setTimeout(r, 50));
    }
    assert.strictEqual(booted, true, 'the account page script did not boot');

    await evaluate(send, `
      addPasswordToggles();
      window.__setPasswordCalls = [];
      window.__setPasswordMode = '401';
      const originalFetch = window.fetch.bind(window);
      window.fetch = async function (url, opts) {
        const href = String(url);
        if (href.indexOf('/api/set-password') === -1) return originalFetch(url, opts);
        const body = opts && opts.body ? JSON.parse(opts.body) : null;
        const auth = (opts && opts.headers && opts.headers.Authorization) || '';
        window.__setPasswordCalls.push({ auth: auth, body: body });
        if (window.__setPasswordMode === 'ok') {
          return { ok: true, status: 200, json: async () => ({ success: true, message: 'Password saved.', token: 'session-after-save' }) };
        }
        if (window.__setPasswordMode === 'bad-current') {
          return { ok: false, status: 401, json: async () => ({ error: 'Current password required' }) };
        }
        return { ok: false, status: 401, json: async () => ({ error: 'Invalid or expired token' }) };
      };
      window.__passwordUi = function () {
        const current = document.getElementById('set-password-current');
        const wrapper = current ? current.closest('.password-wrapper') : null;
        const eye = wrapper ? wrapper.querySelector('.password-toggle') : null;
        const section = document.getElementById('set-password-section');
        const shown = (el) => !!el && el.style.display !== 'none';
        return {
          fieldShown: shown(current) && shown(wrapper),
          eyeShown: !!eye && shown(wrapper) && eye.style.display !== 'none',
          button: document.getElementById('set-password-btn').textContent,
          help: document.getElementById('set-password-help').textContent,
          msg: document.getElementById('set-password-msg').textContent,
          sectionShown: shown(section),
          calls: window.__setPasswordCalls.map((call) => ({
            auth: call.auth,
            currentPassword: call.body ? call.body.currentPassword : undefined,
            password: call.body ? call.body.password : undefined,
          })),
        };
      };
      window.__clickPassword = async function (nextPassword, currentPassword) {
        window.__setPasswordCalls = [];
        document.getElementById('set-password-input').value = nextPassword || '';
        document.getElementById('set-password-current').value = currentPassword || '';
        const btn = document.getElementById('set-password-btn');
        btn.click();
        const started = Date.now();
        while (btn.disabled && Date.now() - started < 3000) {
          await new Promise((r) => setTimeout(r, 15));
        }
        return window.__passwordUi();
      };
      window.__arm = function (hasPassword, token) {
        localStorage.setItem('auth_token', 'session-jwt');
        if (token) sessionStorage.setItem('set_password_token', token);
        else sessionStorage.removeItem('set_password_token');
        syncSetPasswordForm(!!hasPassword);
        return window.__passwordUi();
      };
      true
    `);

    const liveHidden = await evaluate(send, `window.__arm(true, ${JSON.stringify(live)})`);
    assert.strictEqual(liveHidden.fieldShown, false, 'a live purpose token hides Current password');
    await evaluate(send, `sessionStorage.setItem('set_password_token', ${JSON.stringify(expired)})`);
    const expiredDrop = await evaluate(send, `window.__clickPassword('new-password-1', '')`);
    assert.strictEqual(expiredDrop.calls.length, 0, 'expired token does not send an empty current password');
    assert.strictEqual(expiredDrop.fieldShown, true, 'dropping an expired token shows Current password');
    assert.strictEqual(expiredDrop.eyeShown, true, 'dropping an expired token shows the eye');
    assert.strictEqual(expiredDrop.msg, 'Enter your current password to continue.');
    assert.strictEqual(expiredDrop.button, 'Change Password');
    assert.strictEqual(expiredDrop.help, CHANGE_HELP);
    assert.ok(!expiredDrop.help.includes(SET_HELP), 'change mode does not keep the set-password helper');
    const expiredNext = await evaluate(send, `window.__clickPassword('new-password-1', 'typed-current-1')`);
    assert.strictEqual(expiredNext.calls.length, 1, 'the next click sends one request');
    assert.strictEqual(expiredNext.calls[0].auth === 'Bearer session-jwt', true, 'the next click uses the session');
    assert.strictEqual(expiredNext.calls[0].currentPassword, 'typed-current-1');
    assert.strictEqual(expiredNext.calls[0].password, 'new-password-1');

    await evaluate(send, `window.__arm(true, ${JSON.stringify(live)})`);
    await evaluate(send, `window.__setPasswordMode = '401'`);
    const rejected = await evaluate(send, `window.__clickPassword('new-password-1', '')`);
    assert.strictEqual(rejected.calls.length, 1, 'a rejected purpose token is not retried empty');
    assert.strictEqual(rejected.calls[0].auth === 'Bearer ' + live, true, 'the first try still uses the purpose token');
    assert.strictEqual(rejected.calls[0].currentPassword, undefined);
    assert.strictEqual(rejected.fieldShown, true, 'a 401 drop shows Current password');
    assert.strictEqual(rejected.eyeShown, true, 'a 401 drop shows the eye');
    assert.strictEqual(rejected.button, 'Change Password');
    assert.strictEqual(rejected.help, CHANGE_HELP);
    const rejectedNext = await evaluate(send, `window.__clickPassword('new-password-1', 'typed-current-2')`);
    assert.strictEqual(rejectedNext.calls.length, 1);
    assert.strictEqual(rejectedNext.calls[0].auth === 'Bearer session-jwt', true, 'the follow-up click uses the session');
    assert.strictEqual(rejectedNext.calls[0].currentPassword, 'typed-current-2');

    const firstHidden = await evaluate(send, `window.__arm(false, ${JSON.stringify(live)})`);
    assert.strictEqual(firstHidden.fieldShown, false);
    await evaluate(send, `sessionStorage.setItem('set_password_token', ${JSON.stringify(expired)})`);
    const firstDrop = await evaluate(send, `window.__clickPassword('new-password-1', '')`);
    assert.strictEqual(firstDrop.fieldShown, false, 'a first password keeps Current password hidden');
    assert.strictEqual(firstDrop.eyeShown, false, 'a first password keeps the eye hidden');
    assert.strictEqual(firstDrop.button, 'Set Password');
    assert.ok(firstDrop.help.includes(SET_HELP), 'a first password keeps the set helper');

    await evaluate(send, `window.__setPasswordMode = 'bad-current'`);
    const failedChange = await evaluate(send, `
      window.__arm(true, '');
      window.__clickPassword('new-password-1', 'wrong-pass-1')
    `);
    assert.strictEqual(failedChange.button, 'Change Password', 'a failed change does not reset the button');
    assert.ok(failedChange.button !== 'Set / Update Password');
    assert.strictEqual(failedChange.help, CHANGE_HELP, 'a failed change keeps the change helper');
    assert.strictEqual(failedChange.msg, 'Current password required');
    assert.strictEqual(failedChange.fieldShown, true);

    await evaluate(send, `window.__setPasswordMode = 'ok'`);
    const saved = await evaluate(send, `window.__clickPassword('new-password-9', 'typed-current-9')`);
    assert.strictEqual(saved.msg, 'Password saved.');
    assert.strictEqual(saved.button, 'Change Password');
    assert.strictEqual(saved.help, CHANGE_HELP);
    assert.strictEqual(saved.sectionShown, true, 'Password saved. stays on screen');
    assert.strictEqual(saved.calls[0].currentPassword, 'typed-current-9');

    console.log('account-password-form.test.js: ok');
  } finally {
    try { if (pageWs) pageWs.close(); } catch (e) {}
    try { if (browserWs) browserWs.close(); } catch (e) {}
    try { process.kill(-chrome.pid, 'SIGKILL'); } catch (e) { try { chrome.kill('SIGKILL'); } catch (e2) {} }
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(profile, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
