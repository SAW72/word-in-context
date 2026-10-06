'use strict';
/**
 * Signup/checkout email checks, admin user cells, and webhook error text.
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
process.env.WHOP_WEBHOOK_SECRET = 'whsec_unit_test_webhook_secret_value';
process.env.STRIPE_SECRET_KEY = 'sk_test_unit_test_key_not_used_for_network';
process.env.STRIPE_WEBHOOK_SECRET = 'whsec_unit_test_stripe_webhook_secret';
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
        resolve({ status: res.statusCode, headers: res.headers, json, raw });
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

const documentStub = {
  createElement: createEl,
  createTextNode(text) {
    const node = createEl('#text');
    node.textContent = text;
    return node;
  },
};

async function main() {
  const adminHtml = fs.readFileSync(path.join(__dirname, '..', 'public', 'admin.html'), 'utf8');
  assert.ok(!adminHtml.includes('innerHTML'), 'admin page does not assign innerHTML');
  const fillSrc = extractFunction(adminHtml, 'fillAdminUserRow');
  const partsSrc = extractFunction(adminHtml, 'setTextParts');
  assert.ok(fillSrc.includes('textContent'), 'user cells use textContent');
  assert.ok(!fillSrc.includes('innerHTML'));
  assert.ok(!partsSrc.includes('innerHTML'));
  const fillAdminUserRow = new Function('document', fillSrc + '\nreturn fillAdminUserRow;')(documentStub);
  const setTextParts = new Function('document', partsSrc + '\nreturn setTextParts;')(documentStub);

  const sw = fs.readFileSync(path.join(__dirname, '..', 'public', 'sw.js'), 'utf8');
  const navStart = sw.indexOf('async function navigationResponse');
  const navEnd = sw.indexOf('self.addEventListener', navStart);
  const nav = sw.slice(navStart, navEnd);
  assert.ok(nav.includes("path === '/login'"), 'service worker skips /login navigations');
  assert.ok(nav.includes("path === '/success'"), 'service worker skips /success navigations');
  const skip = nav.slice(0, nav.indexOf('try {'));
  assert.ok(skip.includes('return fetch(request)'), '/login and /success are fetched and not written to the cache');

  const { server, port } = await listen();
  try {
    const imgEmail = 'pastor<img src=x>@church.org';
    const quoted = 'user"name@example.com';
    const spaced = 'user name@example.com';
    const tooLong = 'a'.repeat(250) + '@example.com';
    assert.ok(tooLong.length > 254);

    for (const email of [imgEmail, quoted, spaced, tooLong]) {
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

    const okCheckoutShape = await request(port, {
      method: 'POST',
      path: '/api/create-checkout',
      body: { email: 'valid.user+tag@example.com', password: 'password-ok-1' },
    });
    assert.notStrictEqual(okCheckoutShape.status, 400, 'a normal email is not rejected as invalid');

    const userName = 'Sam <b>Lee</b>';
    db.prepare(`
      INSERT INTO users (email, status, access_granted, group_name)
      VALUES (?, 'trialing', 1, ?)
    `).run(imgEmail, userName);

    const login = await request(port, {
      method: 'POST',
      path: '/api/admin/login',
      body: { password: process.env.ADMIN_PASSWORD },
    });
    assert.strictEqual(login.status, 200);
    const users = await request(port, {
      method: 'GET',
      path: '/api/admin/users',
      headers: { Authorization: 'Bearer ' + login.json.token },
    });
    assert.strictEqual(users.status, 200);
    const rowUser = users.json.find((u) => u.email === imgEmail);
    assert.ok(rowUser, 'stored email is returned for the admin table');
    assert.strictEqual(rowUser.group_name, userName);

    const tr = createEl('tr');
    fillAdminUserRow(tr, rowUser);
    const emailCell = tr.children[0];
    const nameCell = tr.children[3];
    assert.strictEqual(emailCell.textContent, imgEmail);
    assert.strictEqual(nameCell.textContent, userName, 'user name with angle brackets is text');
    const html = serialize(tr);
    assert.ok(html.includes('Sam &lt;b&gt;Lee&lt;/b&gt;'), 'user name angle brackets stay text');
    assert.ok(html.includes('&lt;img'), 'email angle brackets are text in the table');
    assert.ok(!html.includes('<img'), 'the table does not create an img element');
    assert.ok(!html.includes('<b>'), 'the table does not create a b element');
    assert.strictEqual(tr.children.filter((child) => child.tag === 'img').length, 0);

    const voiceLine = createEl('p');
    setTextParts(voiceLine, [
      'Status: ',
      { tag: 'strong', text: 'READY' },
      ' · voice: ',
      { tag: 'code', text: '<img src=z>' },
    ]);
    assert.strictEqual(voiceLine.children[3].textContent, '<img src=z>');
    assert.ok(!serialize(voiceLine).includes('<img'));

    const stripeHook = await request(port, {
      method: 'POST',
      path: '/api/stripe-webhook',
      body: '{"id":"evt_test"}',
    });
    assert.strictEqual(stripeHook.status, 400);
    assert.strictEqual(stripeHook.raw, 'Webhook Error');
    assert.ok(String(stripeHook.headers['content-type'] || '').includes('text/plain'));
    assert.ok(!stripeHook.raw.includes('signature'), 'stripe webhook body stays generic');

    const whopHook = await request(port, {
      method: 'POST',
      path: '/api/whop-webhook',
      body: '{"type":"membership.activated"}',
    });
    assert.strictEqual(whopHook.status, 400);
    assert.strictEqual(whopHook.raw, 'Webhook Error');
    assert.ok(String(whopHook.headers['content-type'] || '').includes('text/plain'));
    assert.ok(!whopHook.raw.includes('webhook-id'), 'whop webhook body stays generic');

    const anon = await request(port, { method: 'GET', path: '/api/admin/users' });
    assert.strictEqual(anon.status, 401);
    assert.ok(anon.json && anon.json.error);

    console.log('lib/admin-email.test.js passed');
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
