'use strict';
/**
 * Admin user cells render stored account fields as text.
 * Checkout and signup reject emails that could be HTML.
 */
const assert = require('assert');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

const dbFile = path.join(os.tmpdir(), `wic-admin-email-${process.pid}.db`);
for (const extra of [dbFile, dbFile + '-wal', dbFile + '-shm']) {
  try { fs.unlinkSync(extra); } catch (e) {}
}

process.env.NODE_ENV = 'test';
process.env.WIC_DB_PATH = dbFile;
process.env.JWT_SECRET = 'unit-test-jwt-secret-at-least-32-chars';
process.env.ADMIN_PASSWORD = 'unit-test-admin-password';
process.env.TESTER_INVITE_TOKEN = 'unit-test-invite-token-32chars!!';
process.env.WHOP_CHECKOUT_URL_MONTHLY = 'https://whop.com/checkout/test-plan';
process.env.WHOP_CHECKOUT_URL_YEARLY = '';
process.env.XAI_API_KEY = '';

const { app, db } = require('../server');

const STORED_EMAIL = '<img src=x onerror=alert(1)>@church.org';

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
        resolve({ status: res.statusCode, json, raw });
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
    className: '',
    children: [],
    isText: tag === '#text',
    _text: null,
    set textContent(value) {
      el._text = value == null ? '' : String(value);
      el.children = [];
    },
    get textContent() {
      if (el.children.length) return el.children.map((child) => child.textContent).join('');
      return el._text == null ? '' : el._text;
    },
    appendChild(child) {
      el._text = null;
      el.children.push(child);
      return child;
    },
    replaceChildren() {
      el.children = [];
      el._text = null;
    },
  };
  return el;
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function serialize(el) {
  if (el.isText) return escapeHtml(el.textContent);
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

const documentStub = {
  createElement: createEl,
  createTextNode(text) {
    const node = createEl('#text');
    node.textContent = text;
    return node;
  },
};

async function main() {
  const betasFile = path.join(__dirname, '..', 'betas.json');
  let betasSnapshot = null;
  try { betasSnapshot = fs.readFileSync(betasFile); } catch (e) {}

  const adminHtml = fs.readFileSync(path.join(__dirname, '..', 'public', 'admin.html'), 'utf8');
  assert.ok(!adminHtml.includes('innerHTML'), 'admin page does not assign innerHTML');
  const fillSrc = extractFunction(adminHtml, 'fillAdminUserRow');
  const partsSrc = extractFunction(adminHtml, 'setTextParts');
  assert.ok(fillSrc.includes('textContent'), 'user cells use textContent');
  assert.ok(!fillSrc.includes('innerHTML'));
  assert.ok(!partsSrc.includes('innerHTML'));
  const fillAdminUserRow = new Function('document', fillSrc + '\nreturn fillAdminUserRow;')(documentStub);
  const setTextParts = new Function('document', partsSrc + '\nreturn setTextParts;')(documentStub);

  const { server, port } = await listen();
  try {
    const quoted = 'user"name@example.com';
    const spaced = 'user name@example.com';
    for (const email of [STORED_EMAIL, quoted, spaced]) {
      const checkout = await request(port, {
        method: 'POST',
        path: '/api/create-checkout',
        body: { email, password: 'password-ok-1' },
      });
      assert.strictEqual(checkout.status, 400, 'create-checkout status for ' + email);
      assert.deepStrictEqual(checkout.json, { error: 'Valid email required' });

      const tester = await request(port, {
        method: 'POST',
        path: '/api/tester-signup',
        body: { email, password: 'password-ok-1', inviteToken: process.env.TESTER_INVITE_TOKEN },
      });
      assert.strictEqual(tester.status, 400, 'tester-signup status for ' + email);
      assert.deepStrictEqual(tester.json, { error: 'Valid email required' });

      const beta = await request(port, {
        method: 'POST',
        path: '/api/beta-signup',
        body: { email, name: 'Test' },
      });
      assert.strictEqual(beta.status, 400, 'beta-signup status for ' + email);
      assert.deepStrictEqual(beta.json, { error: 'Valid email required' });
    }

    const stored = db.prepare('SELECT id FROM users WHERE email = ?').get(STORED_EMAIL);
    assert.ok(!stored, 'rejected checkout email is not stored');

    const okCheckout = await request(port, {
      method: 'POST',
      path: '/api/create-checkout',
      body: { email: 'valid.user+tag@example.com', password: 'password-ok-1' },
    });
    assert.notStrictEqual(okCheckout.status, 400, 'a normal email is not rejected as invalid');
    assert.strictEqual(okCheckout.status, 200);

    const userName = 'Sam <b>Lee</b>';
    const hostileStatus = '<img src=x onerror=alert(1)>';
    db.prepare(`
      INSERT INTO users (email, status, access_granted, group_name)
      VALUES (?, ?, 1, ?)
    `).run(STORED_EMAIL, hostileStatus, userName);

    const tr = createEl('tr');
    fillAdminUserRow(tr, {
      email: STORED_EMAIL,
      status: hostileStatus,
      trial_end: null,
      group_name: userName,
      access_granted: 1,
      manual_free: 0,
      created_at: '2026-10-24T12:00:00.000Z',
    });
    assert.strictEqual(tr.children[0].textContent, STORED_EMAIL);
    assert.strictEqual(tr.children[1].textContent, hostileStatus);
    assert.strictEqual(tr.children[3].textContent, userName);
    const html = serialize(tr);
    assert.ok(html.includes('&lt;img src=x onerror=alert(1)&gt;'), 'stored email is escaped text');
    assert.ok(html.includes('Sam &lt;b&gt;Lee&lt;/b&gt;'), 'group name stays text');
    assert.strictEqual(countTag(tr, 'img'), 0, 'the table does not create an img element');
    assert.strictEqual(countTag(tr, 'b'), 0, 'the table does not create a b element');
    assert.ok(!html.includes('<img'), 'serialized row has no img tag');
    assert.ok(!html.includes('<script'), 'serialized row has no script tag');

    const voiceLine = createEl('p');
    setTextParts(voiceLine, [
      'Status: ',
      { tag: 'strong', text: 'READY' },
      ' · voice: ',
      { tag: 'code', text: '<img src=x onerror=alert(1)>' },
    ]);
    assert.strictEqual(voiceLine.children[3].textContent, '<img src=x onerror=alert(1)>');
    assert.strictEqual(countTag(voiceLine, 'img'), 0);
    assert.ok(!serialize(voiceLine).includes('<img'));

    const modelLine = createEl('p');
    setTextParts(modelLine, [
      'Status: ',
      { tag: 'strong', text: 'READY' },
      ' · model ',
      { tag: 'code', text: '<img src=x onerror=alert(1)>' },
    ]);
    assert.strictEqual(modelLine.children[3].textContent, '<img src=x onerror=alert(1)>');
    assert.strictEqual(countTag(modelLine, 'img'), 0);

    const apostrophe = {
      beta: "o'brien.beta@example.ie",
      checkout: "o'brien.checkout@example.ie",
      tester: "o'brien.tester@example.ie",
      admin: "o'brien.admin@example.ie",
      fresh: "o'brien.fresh@example.ie",
    };
    const betaOk = await request(port, {
      method: 'POST',
      path: '/api/beta-signup',
      body: { email: apostrophe.beta, name: "O'Brien" },
    });
    assert.strictEqual(betaOk.status, 200, 'beta signup accepts an apostrophe');
    assert.strictEqual(betaOk.json && betaOk.json.success, true);

    const checkoutOk = await request(port, {
      method: 'POST',
      path: '/api/create-checkout',
      body: { email: apostrophe.checkout, password: 'password-ok-1' },
    });
    assert.strictEqual(checkoutOk.status, 200, 'create-checkout accepts an apostrophe');

    const testerOk = await request(port, {
      method: 'POST',
      path: '/api/tester-signup',
      body: { email: apostrophe.tester, password: 'password-ok-1', inviteToken: process.env.TESTER_INVITE_TOKEN },
    });
    assert.strictEqual(testerOk.status, 200, 'tester signup accepts an apostrophe');
    assert.strictEqual(testerOk.json && testerOk.json.success, true);

    const adminLogin = await request(port, {
      method: 'POST',
      path: '/api/admin/login',
      body: { password: process.env.ADMIN_PASSWORD },
    });
    assert.strictEqual(adminLogin.status, 200, 'admin login');
    const adminHeaders = { Authorization: 'Bearer ' + adminLogin.json.token };
    const adminOk = await request(port, {
      method: 'POST',
      path: '/api/admin/create-special-tester',
      headers: adminHeaders,
      body: { email: apostrophe.admin },
    });
    assert.strictEqual(adminOk.status, 200, 'admin create-tester accepts an apostrophe');
    assert.strictEqual(adminOk.json && adminOk.json.success, true);

    const freshCheckout = await request(port, {
      method: 'POST',
      path: '/api/complete-checkout',
      body: { email: apostrophe.fresh },
    });
    assert.strictEqual(freshCheckout.status, 404, 'an apostrophe with no row is a missing account, not an invalid email');
    assert.notStrictEqual(freshCheckout.json && freshCheckout.json.error, 'email required');

    db.prepare(`UPDATE users SET access_granted = 1, status = 'active' WHERE email = ?`).run(apostrophe.checkout);
    const paidCheckout = await request(port, {
      method: 'POST',
      path: '/api/complete-checkout',
      body: { email: apostrophe.checkout },
    });
    assert.strictEqual(paidCheckout.status, 200, 'complete-checkout accepts an apostrophe on a real account');
    assert.strictEqual(paidCheckout.json && paidCheckout.json.success, true);

    db.prepare(`UPDATE users SET access_granted = 1, status = 'active' WHERE email = ?`).run(STORED_EMAIL);
    const unusual = await request(port, {
      method: 'POST',
      path: '/api/complete-checkout',
      body: { email: STORED_EMAIL },
    });
    assert.strictEqual(unusual.status, 200, 'an existing unusual email still completes checkout');
    assert.strictEqual(unusual.json && unusual.json.success, true);
    assert.strictEqual(unusual.json && unusual.json.email, STORED_EMAIL);

    const blockedShapes = [
      '<img src=x>@church.org',
      'a@b@example.com',
      '.dot@example.com',
      'dot.@example.com',
      'dot@.example.com',
      'dot@example.com.',
      'dot@example..com',
      'a'.repeat(243) + '@example.com',
    ];
    for (const email of blockedShapes) {
      const done = await request(port, {
        method: 'POST',
        path: '/api/complete-checkout',
        body: { email },
      });
      assert.strictEqual(done.status, 400, 'complete-checkout rejects ' + email);
      assert.deepStrictEqual(done.json, { error: 'email required' });
      const made = await request(port, {
        method: 'POST',
        path: '/api/admin/create-special-tester',
        headers: adminHeaders,
        body: { email },
      });
      assert.strictEqual(made.status, 400, 'create-special-tester rejects ' + email);
      assert.deepStrictEqual(made.json, { error: 'Valid email required' });
      const row = db.prepare('SELECT id FROM users WHERE email = ?').get(email.toLowerCase());
      assert.ok(!row, 'rejected address is not stored: ' + email);
    }

    console.log('lib/admin-email.test.js passed');
  } finally {
    server.close();
    try { db.close(); } catch (e) {}
    if (betasSnapshot) fs.writeFileSync(betasFile, betasSnapshot);
    else { try { fs.unlinkSync(betasFile); } catch (e) {} }
    for (const extra of [dbFile, dbFile + '-wal', dbFile + '-shm']) {
      try { fs.unlinkSync(extra); } catch (e) {}
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
