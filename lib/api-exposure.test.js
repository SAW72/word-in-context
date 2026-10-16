'use strict';
/**
 * X-Robots-Tag on /api, /data, and /admin, and a public /api/health of {ok:true}.
 * Detail stays on GET /api/admin/health behind the existing admin JWT.
 */
const assert = require('assert');
const { spawnSync } = require('child_process');
const fs = require('fs');
const http = require('http');
const net = require('net');
const os = require('os');
const path = require('path');
const { performance } = require('perf_hooks');
const jwt = require('jsonwebtoken');

// A second process boots with NODE_ENV=development so the real /api limiter
// (max 300) is mounted. The parent keeps NODE_ENV=test.
const rateLimitChild = process.argv[2] === '--rate-limit';

const dbFile = path.join(os.tmpdir(), `wic-api-exposure-${process.pid}.db`);
for (const extra of [dbFile, dbFile + '-wal', dbFile + '-shm']) {
  try { fs.unlinkSync(extra); } catch (e) {}
}

if (!rateLimitChild) {
  process.env.NODE_ENV = 'test';
}
process.env.WIC_DB_PATH = dbFile;
process.env.JWT_SECRET = 'unit-test-jwt-secret-at-least-32-chars';
process.env.ADMIN_PASSWORD = 'unit-test-admin-password';
process.env.TESTER_INVITE_TOKEN = 'unit-test-invite-token-32chars!!';
process.env.XAI_API_KEY = 'xai-test-key-marker-0123456789abcdef';
process.env.XAI_MODEL = 'grok-test-model-marker';
process.env.RENDER_GIT_COMMIT = 'test-deploy-sha-not-real';
process.env.BUFFER_API_KEY = 'test-buffer-key-not-real';

const { app, db } = require('../server');

const root = path.join(__dirname, '..');
const LEAK_KEYS = [
  'hasKey',
  'xaiKeyLooksValid',
  'hasXaiKey',
  'hasSTT',
  'model',
  'deploy',
  'contentEngine',
  'bufferConfigured',
];

let checks = 0;
const failures = [];

function note(fn) {
  checks += 1;
  try {
    fn();
  } catch (err) {
    failures.push(err && err.message ? err.message : String(err));
  }
}

function listen() {
  return new Promise((resolve) => {
    const server = http.createServer(app);
    server.listen(0, '127.0.0.1', () => {
      resolve({ server, port: server.address().port });
    });
  });
}

function request(port, urlPath, { method, headers, body } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body == null ? null : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
    const req = http.request({
      hostname: '127.0.0.1',
      port,
      method: method || 'GET',
      path: urlPath,
      headers: {
        ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': payload.length } : {}),
        ...(headers || {}),
      },
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = raw ? JSON.parse(raw) : null; } catch (e) {}
        resolve({
          status: res.statusCode,
          headers: res.headers,
          raw,
          json,
        });
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

function rawRequest(port, method, target) {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host: '127.0.0.1', port }, () => {
      socket.write(
        method + ' ' + target + ' HTTP/1.1\r\n' +
        'Host: 127.0.0.1\r\n' +
        'Connection: close\r\n\r\n'
      );
    });
    const chunks = [];
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error('raw socket timeout ' + method + ' ' + target));
    }, 5000);
    socket.on('data', (chunk) => chunks.push(chunk));
    socket.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    socket.on('end', () => {
      clearTimeout(timer);
      const raw = Buffer.concat(chunks).toString('latin1');
      const sep = raw.indexOf('\r\n\r\n');
      const header = sep === -1 ? raw : raw.slice(0, sep);
      const body = sep === -1 ? '' : raw.slice(sep + 4);
      const statusLine = header.split('\r\n', 1)[0] || '';
      const status = Number((statusLine.split(' ')[1] || '').trim());
      const match = /(?:^|\r\n)x-robots-tag:\s*([^\r\n]+)/i.exec(header);
      resolve({
        status,
        robots: match ? match[1].trim() : undefined,
        body,
        header,
      });
    });
  });
}

function robotsOf(res) {
  const value = res.headers['x-robots-tag'];
  if (Array.isArray(value)) return value.join(', ');
  return value === undefined ? undefined : String(value);
}

function assertRobots(res, expected, label) {
  note(() => {
    assert.strictEqual(robotsOf(res), expected, label + ' X-Robots-Tag');
  });
}

function assertNoLeak(raw, json, label) {
  note(() => {
    assert.deepStrictEqual(json, { ok: true }, label + ' body');
  });
  note(() => {
    assert.deepStrictEqual(json && Object.keys(json), ['ok'], label + ' keys');
  });
  for (const key of LEAK_KEYS) {
    note(() => {
      assert.ok(!raw.includes('"' + key + '"'), label + ' must not include ' + key);
    });
  }
  for (const secret of [
    process.env.XAI_API_KEY,
    process.env.RENDER_GIT_COMMIT,
    process.env.BUFFER_API_KEY,
    process.env.XAI_MODEL,
  ]) {
    note(() => {
      assert.ok(secret && !raw.includes(secret), label + ' must not echo a server marker');
    });
  }
}

async function main() {
  const { server, port } = await listen();
  try {
    const health = await request(port, '/api/health');
    note(() => assert.strictEqual(health.status, 200, 'GET /api/health status'));
    note(() => assert.ok(/json/i.test(String(health.headers['content-type'] || '')), 'GET /api/health json'));
    assertRobots(health, 'noindex', 'GET /api/health');
    note(() => {
      assert.ok(health.headers['cache-control'], 'GET /api/health still gets Cache-Control from later middleware');
    });
    assertNoLeak(health.raw, health.json, 'GET /api/health');

    const healthHead = await request(port, '/api/health', { method: 'HEAD' });
    note(() => assert.strictEqual(healthHead.status, 200, 'HEAD /api/health status'));
    assertRobots(healthHead, 'noindex', 'HEAD /api/health');

    const healthQuery = await request(port, '/api/health?ping=1');
    note(() => assert.strictEqual(healthQuery.status, 200, 'GET /api/health?ping=1 status'));
    assertRobots(healthQuery, 'noindex', 'GET /api/health?ping=1');
    assertNoLeak(healthQuery.raw, healthQuery.json, 'GET /api/health?ping=1');

    const healthCase = await request(port, '/API/health');
    note(() => assert.strictEqual(healthCase.status, 200, 'GET /API/health reaches the health handler'));
    assertRobots(healthCase, 'noindex', 'GET /API/health');
    assertNoLeak(healthCase.raw, healthCase.json, 'GET /API/health');

    const healthSlash = await request(port, '/api/health/');
    note(() => assert.strictEqual(healthSlash.status, 200, 'GET /api/health/ reaches the health handler'));
    assertRobots(healthSlash, 'noindex', 'GET /api/health/');
    assertNoLeak(healthSlash.raw, healthSlash.json, 'GET /api/health/');

    const healthDouble = await request(port, '/api//health');
    note(() => assert.strictEqual(healthDouble.status, 404, 'GET /api//health is not rewritten onto the health route'));
    assertRobots(healthDouble, 'noindex', 'GET /api//health');

    const healthLead = await request(port, '//api/health');
    note(() => assert.strictEqual(healthLead.status, 404, 'GET //api/health is not rewritten onto the health route'));
    assertRobots(healthLead, 'noindex', 'GET //api/health');

    const apiExact = await request(port, '/api');
    note(() => assert.strictEqual(apiExact.status, 404, 'GET /api status'));
    assertRobots(apiExact, 'noindex', 'GET /api');

    const apiSlash = await request(port, '/api/');
    note(() => assert.strictEqual(apiSlash.status, 404, 'GET /api/ status'));
    assertRobots(apiSlash, 'noindex', 'GET /api/');

    const config = await request(port, '/api/config');
    note(() => assert.strictEqual(config.status, 200, 'GET /api/config status'));
    note(() => assert.ok(/json/i.test(String(config.headers['content-type'] || '')), 'GET /api/config json'));
    note(() => assert.strictEqual(typeof config.json.trialDays, 'number', 'GET /api/config trialDays'));
    note(() => assert.ok(config.json.paymentProvider, 'GET /api/config paymentProvider'));
    assertRobots(config, 'noindex', 'GET /api/config');

    const me = await request(port, '/api/me');
    note(() => assert.strictEqual(me.status, 401, 'GET /api/me status'));
    note(() => assert.strictEqual(me.json && me.json.error, 'Authentication required', 'GET /api/me error'));
    assertRobots(me, 'noindex', 'GET /api/me');

    const missing = await request(port, '/api/xyz');
    note(() => assert.strictEqual(missing.status, 404, 'GET /api/xyz status'));
    assertRobots(missing, 'noindex', 'GET /api/xyz');

    const lexicon = await request(port, '/data/study-lexicon.json');
    note(() => assert.strictEqual(lexicon.status, 200, 'GET /data/study-lexicon.json status'));
    note(() => assert.ok(/json/i.test(String(lexicon.headers['content-type'] || '')), 'lexicon json'));
    note(() => assert.ok(lexicon.raw.includes('"greek"'), 'lexicon body'));
    note(() => assert.ok(lexicon.headers['cache-control'], 'static response still has Cache-Control'));
    assertRobots(lexicon, 'noindex', 'GET /data/study-lexicon.json');

    const lexiconDouble = await request(port, '/data//study-lexicon.json');
    note(() => assert.strictEqual(lexiconDouble.status, 200, 'GET /data//study-lexicon.json is served by static'));
    assertRobots(lexiconDouble, 'noindex', 'GET /data//study-lexicon.json');

    const lexiconCase = await request(port, '/DATA/study-lexicon.json');
    note(() => assert.strictEqual(lexiconCase.status, 404, 'GET /DATA/study-lexicon.json misses the file on a case-sensitive disk'));
    assertRobots(lexiconCase, 'noindex', 'GET /DATA/study-lexicon.json');

    const admin = await request(port, '/admin');
    note(() => assert.strictEqual(admin.status, 200, 'GET /admin status'));
    note(() => assert.ok(/text\/html/i.test(String(admin.headers['content-type'] || '')), 'GET /admin html'));
    assertRobots(admin, 'noindex, nofollow', 'GET /admin');

    const adminSlash = await request(port, '/admin/');
    note(() => assert.strictEqual(adminSlash.status, 200, 'GET /admin/ reaches the admin page'));
    assertRobots(adminSlash, 'noindex, nofollow', 'GET /admin/');

    const adminCase = await request(port, '/ADMIN');
    note(() => assert.strictEqual(adminCase.status, 200, 'GET /ADMIN reaches the admin page'));
    assertRobots(adminCase, 'noindex, nofollow', 'GET /ADMIN');

    const adminDouble = await request(port, '/admin//');
    note(() => assert.strictEqual(adminDouble.status, 404, 'GET /admin// is not the admin page'));
    assertRobots(adminDouble, 'noindex, nofollow', 'GET /admin//');

    const appPage = await request(port, '/app');
    note(() => assert.strictEqual(appPage.status, 200, 'GET /app status'));
    assertRobots(appPage, 'noindex, follow', 'GET /app');

    const appSlash = await request(port, '/app/');
    note(() => assert.strictEqual(appSlash.status, 200, 'GET /app/ status'));
    assertRobots(appSlash, 'noindex, follow', 'GET /app/');

    const appCase = await request(port, '/APP');
    note(() => assert.strictEqual(appCase.status, 200, 'GET /APP reaches /app'));
    assertRobots(appCase, 'noindex, follow', 'GET /APP');

    const appHead = await request(port, '/app', { method: 'HEAD' });
    note(() => assert.strictEqual(appHead.status, 200, 'HEAD /app status'));
    assertRobots(appHead, 'noindex, follow', 'HEAD /app');

    const appOptions = await request(port, '/app', { method: 'OPTIONS' });
    note(() => assert.strictEqual(appOptions.status, 200, 'OPTIONS /app status'));
    assertRobots(appOptions, 'noindex, follow', 'OPTIONS /app');

    const appSlashOptions = await request(port, '/app/', { method: 'OPTIONS' });
    note(() => assert.strictEqual(appSlashOptions.status, 200, 'OPTIONS /app/ status'));
    assertRobots(appSlashOptions, 'noindex, follow', 'OPTIONS /app/');

    const appQueryOptions = await request(port, '/app?x=1', { method: 'OPTIONS' });
    note(() => assert.strictEqual(appQueryOptions.status, 200, 'OPTIONS /app?x=1 status'));
    assertRobots(appQueryOptions, 'noindex, follow', 'OPTIONS /app?x=1');

    const appCaseOptions = await request(port, '/APP', { method: 'OPTIONS' });
    note(() => assert.strictEqual(appCaseOptions.status, 200, 'OPTIONS /APP status'));
    assertRobots(appCaseOptions, 'noindex, follow', 'OPTIONS /APP');

    const appAnything = await request(port, '/app/anything');
    note(() => assert.strictEqual(appAnything.status, 404, 'GET /app/anything status'));
    assertRobots(appAnything, undefined, 'GET /app/anything');

    const appAnythingOptions = await request(port, '/app/anything', { method: 'OPTIONS' });
    note(() => assert.strictEqual(appAnythingOptions.status, 404, 'OPTIONS /app/anything status'));
    assertRobots(appAnythingOptions, undefined, 'OPTIONS /app/anything');

    const home = await request(port, '/');
    note(() => assert.strictEqual(home.status, 200, 'GET / status'));
    note(() => assert.ok(/text\/html/i.test(String(home.headers['content-type'] || '')), 'GET / html'));
    assertRobots(home, undefined, 'GET /');

    const read = await request(port, '/read');
    note(() => assert.strictEqual(read.status, 200, 'GET /read status'));
    note(() => assert.ok(/text\/html/i.test(String(read.headers['content-type'] || '')), 'GET /read html'));
    note(() => {
      assert.ok(
        read.raw.includes('<title>Read the Bible \u2014 The Word in Context</title>'),
        'GET /read title unchanged'
      );
    });
    note(() => assert.ok(read.raw.includes('<h1>Read the Bible</h1>'), 'GET /read H1 unchanged'));
    note(() => assert.ok(read.raw.includes('/reader.js'), 'GET /read still loads the reader'));
    assertRobots(read, undefined, 'GET /read');

    const readSlash = await request(port, '/read/');
    note(() => assert.strictEqual(readSlash.status, 200, 'GET /read/ status'));
    assertRobots(readSlash, undefined, 'GET /read/');

    const popup = await request(port, '/john-popup.js');
    note(() => assert.strictEqual(popup.status, 200, 'GET /john-popup.js status'));
    note(() => assert.ok(/javascript/i.test(String(popup.headers['content-type'] || '')), 'GET /john-popup.js js'));
    assertRobots(popup, undefined, 'GET /john-popup.js');

    const css = await request(port, '/reader.css');
    note(() => assert.strictEqual(css.status, 200, 'GET /reader.css status'));
    assertRobots(css, undefined, 'GET /reader.css');

    const readerJs = await request(port, '/reader.js');
    note(() => assert.strictEqual(readerJs.status, 200, 'GET /reader.js status'));
    assertRobots(readerJs, undefined, 'GET /reader.js');

    // Paths static actually serves after one decodeURIComponent, plus malformed encodings.
    // send() decodes once and rejects ".." that still escapes the root.
    const META_ROBOTS = '<meta name="robots" content="noindex,nofollow">';
    const encodedCases = [
      { path: '/%64ata/study-lexicon.json', status: 200, robots: 'noindex', includes: '"greek"' },
      { path: '/%64%61%74%61/study-lexicon.json', status: 200, robots: 'noindex', includes: '"greek"' },
      { path: '/data%2fstudy-lexicon.json', status: 200, robots: 'noindex', includes: '"greek"' },
      { path: '/data%2Fstudy-lexicon.json', status: 200, robots: 'noindex', includes: '"greek"' },
      { path: '/%64ata//study-lexicon.json', status: 200, robots: 'noindex', includes: '"greek"' },
      { path: '/%2e/data/study-lexicon.json', status: 200, robots: 'noindex', includes: '"greek"' },
      { path: '/foo/%2e%2e/data/study-lexicon.json', status: 200, robots: 'noindex', includes: '"greek"' },
      { path: '/%64ata/%2e%2e/%64ata/study-lexicon.json', status: 200, robots: 'noindex', includes: '"greek"' },
      { path: '/%2564ata/study-lexicon.json', status: 404, robots: undefined, excludes: '"greek"' },
      { path: '/%2e%2e/data/study-lexicon.json', status: 404, robots: 'noindex', excludes: '"greek"' },
      { path: '/admin.html', status: 200, robots: 'noindex, nofollow', includes: META_ROBOTS },
      { path: '/ADMIN.html', status: 404, robots: 'noindex, nofollow' },
      { path: '/Admin.HTML', status: 404, robots: 'noindex, nofollow' },
      { path: '/%61dmin.html', status: 200, robots: 'noindex, nofollow', includes: META_ROBOTS },
      { path: '/%61%64min.html', status: 200, robots: 'noindex, nofollow', includes: META_ROBOTS },
      { path: '/admin%2ehtml', status: 200, robots: 'noindex, nofollow', includes: META_ROBOTS },
      { path: '/foo/%2e%2e/admin.html', status: 200, robots: 'noindex, nofollow', includes: META_ROBOTS },
      { path: '/%61dmin', status: 404, robots: 'noindex, nofollow' },
      { path: '/%61dmin/', status: 404, robots: 'noindex, nofollow' },
      { path: '/%41dmin.html', status: 404, robots: 'noindex, nofollow' },
      { path: '/%2e%2e/admin.html', status: 404, robots: 'noindex, nofollow', excludes: 'id="admin-pass"' },
      { path: '/%6aohn-popup.js', status: 200, robots: undefined, includes: 'Embeddable' },
      { path: '/john-popup%2ejs', status: 200, robots: undefined, includes: 'Embeddable' },
      { path: '/foo/%2e%2e/john-popup.js', status: 200, robots: undefined, includes: 'Embeddable' },
      { path: '/%72eader.css', status: 200, robots: undefined },
      { path: '/reader%2ecss', status: 200, robots: undefined },
      { path: '/foo/%2e%2e/reader.css', status: 200, robots: undefined },
      { path: '/%72ead', status: 404, robots: undefined },
      { path: '/%61pp', status: 404, robots: undefined },
      { path: '/%E0%A4%A', status: 404, robots: undefined },
      { path: '/%zz', status: 404, robots: undefined },
      { path: '/api/%zz', status: 404, robots: 'noindex' },
      { path: '/data/%zz', status: 404, robots: 'noindex' },
      { path: '/%64ata/%zz', status: 404, robots: undefined, excludes: '"greek"' },
      { method: 'OPTIONS', path: '/api/health', status: 200, robots: 'noindex', noLeak: true },
      { method: 'OPTIONS', path: '/api/admin/health', status: 200, robots: 'noindex', noLeak: true, cache: 'no-store' },
      { method: 'OPTIONS', path: '/data/study-lexicon.json', status: 404, robots: 'noindex', noLeak: true, excludes: '"greek"' },
      { method: 'OPTIONS', path: '/admin', status: 200, robots: 'noindex, nofollow', noLeak: true },
      { method: 'OPTIONS', path: '/admin.html', status: 404, robots: 'noindex, nofollow', noLeak: true },
      { method: 'OPTIONS', path: '/%64ata/study-lexicon.json', status: 404, robots: 'noindex', noLeak: true, excludes: '"greek"' },
      { path: '/data%00/study-lexicon.json', status: 404, robots: 'noindex', excludes: '"greek"' },
      { path: '/admin%00', status: 404, robots: 'noindex, nofollow' },
      { path: '/api/../x', status: 404, robots: 'noindex' },
      { path: '/api/%2e%2e/x', status: 404, robots: 'noindex' },
      { path: '/%2e%2e/api/x', status: 404, robots: 'noindex', excludes: '{"ok":true}' },
      { path: '/api/../..', status: 404, robots: 'noindex' },
      { path: '//api/../x', status: 404, robots: 'noindex' },
      { path: '/API/%zz', status: 404, robots: 'noindex' },
      { path: '//api/%zz', status: 404, robots: 'noindex' },
      { path: '/admin.html/', status: 404, robots: 'noindex, nofollow' },
      { path: '/apidocs', status: 404, robots: undefined },
      { path: '/adminfoo/x.js', status: 404, robots: undefined },
      { path: '/api/../john-popup.js', status: 200, robots: undefined, includes: 'Embeddable' },
      { path: '/data/../john-popup.js', status: 200, robots: undefined, includes: 'Embeddable' },
      { path: '/data/%2e%2e/reader.css', status: 200, robots: undefined },
      { path: '/index.html', status: 200, robots: undefined, includes: '<title>' },
      { path: '/data/%2e%2e/index.html', status: 200, robots: undefined, includes: '<title>' },
      { path: '/data/%2e%2e/server.js', status: 404, robots: 'noindex', excludes: 'require(' },
      { method: 'HEAD', path: '/%2e%2e/data/study-lexicon.json', status: 404, robots: 'noindex' },
      { method: 'OPTIONS', path: '/%2e%2e/data/study-lexicon.json', status: 404, robots: 'noindex', excludes: '"greek"' },
      { method: 'HEAD', path: '/data%00/study-lexicon.json', status: 404, robots: 'noindex' },
      { method: 'OPTIONS', path: '/api/../x', status: 404, robots: 'noindex' },
      { path: '/%', status: 404, robots: undefined },
      { path: '/api/%', status: 404, robots: 'noindex' },
      { path: '/data/%E0%A4%A', status: 404, robots: 'noindex' },
    ];
    for (const c of encodedCases) {
      const method = c.method || 'GET';
      const res = await request(port, c.path, { method });
      const label = method + ' ' + c.path;
      note(() => assert.notStrictEqual(res.status, 500, label + ' must not 500'));
      note(() => assert.strictEqual(res.status, c.status, label + ' status'));
      assertRobots(res, c.robots, label);
      if (c.includes) {
        note(() => assert.ok(res.raw.includes(c.includes), label + ' body marker'));
      }
      if (c.excludes) {
        note(() => assert.ok(!res.raw.includes(c.excludes), label + ' must not include served file marker'));
      }
      if (c.cache) {
        note(() => {
          assert.ok(
            String(res.headers['cache-control'] || '').toLowerCase().includes(c.cache),
            label + ' Cache-Control'
          );
        });
      }
      if (c.noLeak) {
        for (const key of LEAK_KEYS) {
          note(() => assert.ok(!res.raw.includes('"' + key + '"'), label + ' must not include ' + key));
        }
      }
    }

    // Raw request line via net.connect. Nothing rewrites ".." or "%00" before Express.
    const rawCases = [
      { method: 'GET', path: '/%2e%2e/data/study-lexicon.json', status: 404, robots: 'noindex', excludes: '"greek"' },
      { method: 'HEAD', path: '/%2e%2e/data/study-lexicon.json', status: 404, robots: 'noindex' },
      { method: 'OPTIONS', path: '/%2e%2e/data/study-lexicon.json', status: 404, robots: 'noindex' },
      { method: 'GET', path: '/data%00/study-lexicon.json', status: 404, robots: 'noindex', excludes: '"greek"' },
      { method: 'HEAD', path: '/data%00/study-lexicon.json', status: 404, robots: 'noindex' },
      { method: 'OPTIONS', path: '/data%00/study-lexicon.json', status: 404, robots: 'noindex' },
      { method: 'GET', path: '/api/../x', status: 404, robots: 'noindex' },
      { method: 'HEAD', path: '/api/../x', status: 404, robots: 'noindex' },
      { method: 'OPTIONS', path: '/api/../x', status: 404, robots: 'noindex' },
      { method: 'GET', path: '/%2e%2e/api/x', status: 404, robots: 'noindex' },
      { method: 'GET', path: '/api/../..', status: 404, robots: 'noindex' },
      { method: 'GET', path: '//api/../x', status: 404, robots: 'noindex' },
      { method: 'GET', path: '/%zz', status: 404, robots: undefined },
      { method: 'GET', path: '/API/%zz', status: 404, robots: 'noindex' },
      { method: 'GET', path: '//api/%zz', status: 404, robots: 'noindex' },
      { method: 'GET', path: '/app', status: 200, robots: 'noindex, follow' },
      { method: 'HEAD', path: '/app', status: 200, robots: 'noindex, follow' },
      { method: 'OPTIONS', path: '/app', status: 200, robots: 'noindex, follow' },
      { method: 'OPTIONS', path: '/app/', status: 200, robots: 'noindex, follow' },
      { method: 'OPTIONS', path: '/APP', status: 200, robots: 'noindex, follow' },
      { method: 'GET', path: '/app/anything', status: 404, robots: undefined },
      { method: 'OPTIONS', path: '/app/anything', status: 404, robots: undefined },
      { method: 'GET', path: '/john-popup.js', status: 200, robots: undefined, includes: 'Embeddable' },
      { method: 'GET', path: '/api/../john-popup.js', status: 200, robots: undefined, includes: 'Embeddable' },
      { method: 'GET', path: '/', status: 200, robots: undefined },
      { method: 'GET', path: '/read', status: 200, robots: undefined },
      { method: 'GET', path: '/reader.css', status: 200, robots: undefined },
      { method: 'GET', path: '/index.html', status: 200, robots: undefined },
      { method: 'GET', path: '/data/%2e%2e/index.html', status: 200, robots: undefined },
    ];
    for (const c of rawCases) {
      let res;
      try {
        res = await rawRequest(port, c.method, c.path);
      } catch (err) {
        failures.push('raw ' + c.method + ' ' + c.path + ': ' + (err && err.message ? err.message : err));
        checks += 1;
        continue;
      }
      const label = 'raw ' + c.method + ' ' + c.path;
      note(() => assert.notStrictEqual(res.status, 500, label + ' must not 500'));
      note(() => assert.strictEqual(res.status, c.status, label + ' status'));
      note(() => assert.strictEqual(res.robots, c.robots, label + ' X-Robots-Tag'));
      if (c.includes) {
        note(() => assert.ok(res.body.includes(c.includes), label + ' body marker'));
      }
      if (c.excludes) {
        note(() => assert.ok(!res.body.includes(c.excludes), label + ' must not include served file marker'));
      }
    }

    const robots = await request(port, '/robots.txt');
    note(() => assert.strictEqual(robots.status, 200, 'GET /robots.txt status'));
    assertRobots(robots, undefined, 'GET /robots.txt');
    const robotsFile = fs.readFileSync(path.join(root, 'public', 'robots.txt'), 'utf8');
    note(() => assert.strictEqual(robots.raw, robotsFile, 'GET /robots.txt matches the file'));
    note(() => assert.ok(robotsFile.includes('Disallow: /api/'), 'robots.txt still disallows /api/'));
    note(() => assert.ok(robotsFile.includes('Disallow: /admin'), 'robots.txt still disallows /admin'));
    note(() => assert.ok(!robotsFile.includes('Disallow: /data'), 'robots.txt does not disallow /data'));
    note(() => assert.ok(!/john-popup/.test(robotsFile), 'robots.txt does not mention john-popup.js'));

    const login = await request(port, '/api/admin/login', {
      method: 'POST',
      body: { password: process.env.ADMIN_PASSWORD },
    });
    note(() => assert.strictEqual(login.status, 200, 'admin login'));
    const token = login.json && login.json.token;
    note(() => assert.ok(token, 'admin login returns a token'));

    const publicWithToken = await request(port, '/api/health', {
      headers: { Authorization: 'Bearer ' + token },
    });
    assertNoLeak(publicWithToken.raw, publicWithToken.json, 'GET /api/health with admin token');
    assertRobots(publicWithToken, 'noindex', 'GET /api/health with admin token');

    const detailAnon = await request(port, '/api/admin/health');
    note(() => assert.strictEqual(detailAnon.status, 401, 'admin health without token'));
    note(() => assert.strictEqual(detailAnon.json && detailAnon.json.error, 'Admin required'));
    for (const key of LEAK_KEYS) {
      note(() => {
        assert.ok(!detailAnon.raw.includes('"' + key + '"'), 'anon admin health must not include ' + key);
      });
    }
    assertRobots(detailAnon, 'noindex', 'GET /api/admin/health without token');
    note(() => {
      assert.ok(
        String(detailAnon.headers['cache-control'] || '').toLowerCase().includes('no-store'),
        'GET /api/admin/health without token is no-store'
      );
    });

    const detailBad = await request(port, '/api/admin/health', {
      headers: { Authorization: 'Bearer not-a-token' },
    });
    note(() => assert.strictEqual(detailBad.status, 401, 'admin health with a bad token'));

    const userToken = jwt.sign({ role: 'user', email: 'reader@example.com' }, process.env.JWT_SECRET);
    const detailUser = await request(port, '/api/admin/health', {
      headers: { Authorization: 'Bearer ' + userToken },
    });
    note(() => assert.strictEqual(detailUser.status, 401, 'admin health rejects a non-admin JWT'));

    const detail = await request(port, '/api/admin/health', {
      headers: { Authorization: 'Bearer ' + token },
    });
    note(() => assert.strictEqual(detail.status, 200, 'admin health with token'));
    note(() => {
      assert.deepStrictEqual(detail.json, {
        ok: true,
        hasKey: true,
        xaiKeyLooksValid: true,
        hasXaiKey: true,
        hasSTT: false,
        model: process.env.XAI_MODEL,
        deploy: process.env.RENDER_GIT_COMMIT,
        contentEngine: true,
        bufferConfigured: true,
      });
    });
    note(() => assert.ok(!detail.raw.includes(process.env.XAI_API_KEY), 'admin health must not echo the API key'));
    note(() => assert.ok(!detail.raw.includes(process.env.BUFFER_API_KEY), 'admin health must not echo the buffer key'));
    assertRobots(detail, 'noindex', 'GET /api/admin/health');
    note(() => {
      assert.ok(
        String(detail.headers['cache-control'] || '').toLowerCase().includes('no-store'),
        'GET /api/admin/health with token is no-store'
      );
    });

    const indexHtml = fs.readFileSync(path.join(root, 'public', 'index.html'), 'utf8');
    note(() => assert.ok(!indexHtml.includes('d.hasKey'), 'public app must not read hasKey from /api/health'));
    note(() => assert.ok(!indexHtml.includes('xaiKeyLooksValid'), 'public app must not read xaiKeyLooksValid'));
    note(() => assert.ok(!indexHtml.includes('No XAI_API_KEY configured'), 'public app must not warn about the API key'));
    note(() => assert.ok(indexHtml.includes('cfg.hasSTT'), 'STT flag still comes from /api/config'));

    const adminHtml = fs.readFileSync(path.join(root, 'public', 'admin.html'), 'utf8');
    note(() => assert.ok(adminHtml.includes('/api/admin/health'), 'admin page reads detail from the admin health route'));
    note(() => assert.ok(adminHtml.includes('loadAdminHealth'), 'admin page loads health detail after login'));
    note(() => {
      assert.ok(
        adminHtml.includes('<meta name="robots" content="noindex,nofollow">'),
        'admin.html has a robots meta tag'
      );
    });
    const healthFnStart = adminHtml.indexOf('async function loadAdminHealth');
    const healthFnEnd = adminHtml.indexOf('// Auto-restore admin session');
    const healthFn = adminHtml.slice(healthFnStart, healthFnEnd);
    note(() => assert.ok(healthFnStart !== -1 && healthFnEnd > healthFnStart, 'loadAdminHealth function is present'));
    note(() => assert.ok(healthFn.includes("fetch(base + '/api/admin/health'"), 'admin.html fetches /api/admin/health'));
    note(() => {
      assert.ok(
        healthFn.includes("'Authorization': 'Bearer ' + adminToken"),
        'admin.html sends Authorization to /api/admin/health'
      );
    });

    let seo = null;
    try {
      seo = require('./seo-headers');
    } catch (err) {
      failures.push('seo-headers module: ' + (err && err.message ? err.message : err));
    }
    if (seo) {
      const samples = [
        ['/api', 'noindex'],
        ['/api/', 'noindex'],
        ['/API/health', 'noindex'],
        ['/api//health', 'noindex'],
        ['//api/health', 'noindex'],
        ['/data/study-lexicon.json', 'noindex'],
        ['/data/', 'noindex'],
        ['/DATA/study-lexicon.json', 'noindex'],
        ['/data', null],
        ['/dataset', null],
        ['/admin', 'noindex, nofollow'],
        ['/admin/', 'noindex, nofollow'],
        ['/ADMIN', 'noindex, nofollow'],
        ['/admin//', 'noindex, nofollow'],
        ['//admin', 'noindex, nofollow'],
        ['/admin-panel', null],
        ['/administrator', null],
        ['/admin.html', 'noindex, nofollow'],
        ['/ADMIN.html', 'noindex, nofollow'],
        ['/%61dmin', 'noindex, nofollow'],
        ['/%61dmin.html', 'noindex, nofollow'],
        ['/admin%2ehtml', 'noindex, nofollow'],
        ['/foo/%2e%2e/admin.html', 'noindex, nofollow'],
        ['/%2e%2e/admin.html', 'noindex, nofollow'],
        ['/%64ata/study-lexicon.json', 'noindex'],
        ['/data%2fstudy-lexicon.json', 'noindex'],
        ['/%2e/data/study-lexicon.json', 'noindex'],
        ['/foo/%2e%2e/data/study-lexicon.json', 'noindex'],
        ['/%2e%2e/data/study-lexicon.json', 'noindex'],
        ['/%2564ata/study-lexicon.json', null],
        ['/%6aohn-popup.js', null],
        ['/john-popup%2ejs', null],
        ['/foo/%2e%2e/john-popup.js', null],
        ['/%72eader.css', null],
        ['/%72ead', null],
        ['/%61pp', null],
        ['/%E0%A4%A', null],
        ['/%zz', null],
        ['/api/%zz', 'noindex'],
        ['/%64ata/%zz', null],
        ['/app', 'noindex, follow'],
        ['/app/', 'noindex, follow'],
        ['/APP', 'noindex, follow'],
        ['/app/anything', null],
        ['/app/../app', null],
        ['/%61pp', null],
        ['/application', null],
        ['/', null],
        ['/read', null],
        ['/read/', null],
        ['/john-popup.js', null],
        ['/reader.css', null],
        ['/api/config?x=1', 'noindex'],
        // Today's tags at 875ef637, pinned so prefix mutants stay dead:
        // /API/%zz is noindex because lowercase runs before a failed decode.
        // //api/%zz is noindex because the failed decode keeps the raw path after slash collapse.
        // /admin.html/ is noindex, nofollow because one trailing slash is stripped first.
        // /api/../.. is noindex because the raw /api/ prefix is kept when ".." still escapes.
        // /apidocs and /adminfoo/x.js are untagged: the prefix must be a boundary, not a substring.
        ['/API/%zz', 'noindex'],
        ['//api/%zz', 'noindex'],
        ['/admin.html/', 'noindex, nofollow'],
        ['/api/../..', 'noindex'],
        ['//api/../x', 'noindex'],
        ['/apidocs', null],
        ['/adminfoo/x.js', null],
        ['/data%00/study-lexicon.json', 'noindex'],
        ['/admin%00', 'noindex, nofollow'],
        ['/api%00/health', 'noindex'],
        ['/api/../x', 'noindex'],
        ['/api/%2e%2e/x', 'noindex'],
        ['/%2e%2e/api/x', 'noindex'],
        ['/API/../x', 'noindex'],
        ['/api/../john-popup.js', null],
        ['/data/../index.html', null],
        ['/data/%2e%2e/index.html', null],
        ['/index.html', null],
        ['/data/%2e%2e/reader.css', null],
        ['/data/%2e%2e/server.js', 'noindex'],
        ['/%', null],
        ['/api/%', 'noindex'],
        ['/%zz', null],
        ['/data/%zz', 'noindex'],
      ];
      for (const [sample, expected] of samples) {
        note(() => {
          assert.strictEqual(seo.robotsTagForPath(sample), expected, 'robotsTagForPath ' + sample);
        });
      }

      // Old function: path.posix.normalize. New function may skip that call.
      // Tags must still match, including long "/.." runs, NUL, and malformed "%".
      const UP_PATH = /(?:^|[\\/])\.\.(?:[\\/]|$)/;
      const PUBLIC_EXACT = new Set([
        '/', '/read', '/privacy', '/terms', '/index.html', '/john-popup.js', '/reader.css',
        '/reader.js', '/reader.html', '/privacy.html', '/terms.html', '/robots.txt',
        '/sitemap.xml', '/sw.js', '/manifest.webmanifest', '/landing.html',
        '/instructions.html', '/attributions.html', '/pwa.css', '/pwa.js',
        '/login-verify.js', '/share-redirect.js', '/share-video.js', '/study-core.js',
        '/success-checkout.js', '/voice-picker.js', '/audio-engine.js', '/auth-api.js',
        '/bible-core.js', '/chat-recorder.js', '/icons/icon-192.png', '/icons/icon-512.png',
        '/icons/icon-maskable-512.png', '/icons/icon-maskable.svg', '/icons/icon.svg',
        '/icons/share-og.png', '/icons/share-og.svg',
      ]);
      function refPrepare(pathname) {
        let p = String(pathname || '/');
        const query = p.indexOf('?');
        if (query !== -1) p = p.slice(0, query);
        const hash = p.indexOf('#');
        if (hash !== -1) p = p.slice(0, hash);
        p = p.toLowerCase();
        if (!p.startsWith('/')) p = '/' + p;
        return p.replace(/\/{2,}/g, '/');
      }
      function refDecode(pathname) {
        try { return decodeURIComponent(pathname); } catch (err) { return null; }
      }
      function refStrip(p) {
        return p.length > 1 && p.endsWith('/') ? p.slice(0, -1) : p;
      }
      function refAdminFile(stripped) {
        if (!stripped.startsWith('/admin')) return false;
        if (stripped.indexOf('/', 1) !== -1) return false;
        const name = stripped.slice(1);
        return name.length > 'admin'.length && name.includes('.');
      }
      function refTagOne(p) {
        if (!p) return null;
        const stripped = refStrip(p);
        if (stripped === '/api' || p.startsWith('/api/') || stripped.startsWith('/api/')
          || p.startsWith('/api%00') || p.startsWith('/api\0')) return 'noindex';
        if (stripped === '/admin' || p.startsWith('/admin/') || stripped.startsWith('/admin/')
          || p.startsWith('/admin%00') || p.startsWith('/admin\0') || refAdminFile(stripped)) {
          return 'noindex, nofollow';
        }
        if (p.startsWith('/data/') || stripped.startsWith('/data/')
          || p.startsWith('/data%00') || p.startsWith('/data\0')) return 'noindex';
        return null;
      }
      function refStronger(a, b) {
        if (a === 'noindex, nofollow' || b === 'noindex, nofollow') return 'noindex, nofollow';
        return a || b || null;
      }
      function referenceTag(pathname) {
        const raw = refPrepare(pathname);
        const decodedText = refDecode(raw);
        let decoded = null;
        if (decodedText != null) {
          let text = decodedText.toLowerCase();
          if (!text.startsWith('/')) text = '/' + text;
          decoded = text.replace(/\/{2,}/g, '/');
        }
        if (refStrip(raw) === '/app') return 'noindex, follow';
        const basis = decoded || raw;
        const normalized = path.posix.normalize(basis);
        let inRoot = normalized;
        if (basis.indexOf('\0') !== -1) inRoot = null;
        else if (basis.indexOf('/.') !== -1) {
          const sendStyle = path.posix.normalize('./' + basis);
          if (UP_PATH.test(sendStyle)) inRoot = null;
        }
        const nul = raw.indexOf('%00') !== -1 || (decoded && decoded.indexOf('\0') !== -1);
        if (!nul && inRoot && PUBLIC_EXACT.has(refStrip(inRoot))) return null;
        let tag = refTagOne(raw);
        if (decoded) tag = refStronger(tag, refTagOne(decoded));
        tag = refStronger(tag, refTagOne(normalized));
        return tag;
      }
      const longDots = '/..'.repeat(5400);
      const corpus = samples.map((pair) => pair[0]).concat([
        longDots,
        longDots + '/data/study-lexicon.json',
        '/api' + '/..'.repeat(2000) + '/x',
        '/data' + '/..'.repeat(2000) + '/john-popup.js',
        '/%2e%2e'.repeat(40) + '/data/study-lexicon.json',
        '/data%00/' + 'a/'.repeat(50) + 'x',
        '/admin/%2e%2e/api/health',
        '/API//health',
        '/data//study-lexicon.json',
        '/%E0%A4%A',
        '/%64ata/%zz',
        '/foo/%2e%2e/admin.html',
        '/read/../data/study-lexicon.json',
        null,
        undefined,
        '',
        0,
      ]);
      for (const sample of corpus) {
        let expected;
        let actual;
        try {
          expected = referenceTag(sample);
          actual = seo.robotsTagForPath(sample);
        } catch (err) {
          failures.push('differential throw ' + sample + ': ' + (err && err.message ? err.message : err));
          checks += 1;
          continue;
        }
        note(() => {
          assert.strictEqual(actual, expected, 'differential robotsTagForPath ' + sample);
        });
      }
      if (typeof seo.normalizeSeoPath === 'function') {
        for (const sample of corpus) {
          if (sample == null || typeof sample === 'number') continue;
          let expectedNorm;
          let actualNorm;
          try {
            expectedNorm = path.posix.normalize(refPrepare(String(sample || '/')));
            const decodedText = refDecode(refPrepare(String(sample || '/')));
            if (decodedText != null) {
              let text = decodedText.toLowerCase();
              if (!text.startsWith('/')) text = '/' + text;
              expectedNorm = path.posix.normalize(text.replace(/\/{2,}/g, '/'));
            }
            actualNorm = seo.normalizeSeoPath(sample);
          } catch (err) {
            failures.push('normalize differential throw ' + sample + ': ' + err.message);
            checks += 1;
            continue;
          }
          note(() => {
            assert.strictEqual(actualNorm, expectedNorm, 'normalizeSeoPath vs path.posix.normalize ' + sample);
          });
        }
      } else {
        failures.push('normalizeSeoPath is missing');
        checks += 1;
      }
      const benchN = 80;
      const benchStart = performance.now();
      for (let i = 0; i < benchN; i++) seo.robotsTagForPath(longDots);
      const benchMean = (performance.now() - benchStart) / benchN;
      const posixStart = performance.now();
      for (let i = 0; i < benchN; i++) path.posix.normalize(longDots);
      const posixMean = (performance.now() - posixStart) / benchN;
      console.log(
        'agent-run bench node ' + process.version +
        ': robotsTagForPath 16200-char /.. mean ' + benchMean.toFixed(3) +
        ' ms; path.posix.normalize mean ' + posixMean.toFixed(3) + ' ms'
      );
      note(() => {
        assert.ok(benchMean < 1, 'long /.. robotsTagForPath stays under 1 ms, got ' + benchMean.toFixed(3));
      });

      await new Promise((resolve, reject) => {
        const express = require('express');
        const mini = express();
        mini.use(seo.seoNoindexHeaders);
        mini.get('/api/probe', (req, res) => {
          res.removeHeader('X-Robots-Tag');
          res.set('Cache-Control', 'no-store');
          res.set('X-Robots-Tag', 'index, follow');
          res.json({ ok: true });
        });
        mini.use(express.static(path.join(root, 'public'), {
          setHeaders(res, filePath) {
            res.setHeader('Cache-Control', 'public, max-age=60');
            if (String(filePath).includes('study-lexicon')) {
              res.setHeader('X-Robots-Tag', 'all');
            }
          },
        }));
        const probe = http.createServer(mini);
        probe.listen(0, '127.0.0.1', async () => {
          try {
            const probePort = probe.address().port;
            const locked = await request(probePort, '/api/probe');
            note(() => assert.strictEqual(locked.status, 200, 'overwrite probe status'));
            assertRobots(locked, 'noindex', 'overwrite probe keeps noindex');
            note(() => assert.strictEqual(locked.headers['cache-control'], 'no-store', 'overwrite probe still sets Cache-Control'));
            const lockedFile = await request(probePort, '/data/study-lexicon.json');
            note(() => assert.strictEqual(lockedFile.status, 200, 'static setHeaders probe status'));
            assertRobots(lockedFile, 'noindex', 'static setHeaders cannot replace noindex');
            note(() => {
              assert.ok(
                String(lockedFile.headers['cache-control'] || '').includes('max-age=60'),
                'static setHeaders still sets Cache-Control'
              );
            });
            const homeProbe = await request(probePort, '/john-popup.js');
            assertRobots(homeProbe, undefined, 'static setHeaders does not invent a tag for JS');
            probe.close(() => resolve());
          } catch (err) {
            probe.close(() => reject(err));
          }
        });
      });
    }
  } finally {
    await new Promise((resolve) => server.close(resolve));
    try { db.close(); } catch (e) {}
    for (const extra of [dbFile, dbFile + '-wal', dbFile + '-shm']) {
      try { fs.unlinkSync(extra); } catch (e) {}
    }
  }

  const rate = spawnSync(process.execPath, [__filename, '--rate-limit'], {
    env: Object.assign({}, process.env, { NODE_ENV: 'development' }),
    encoding: 'utf8',
    timeout: 120000,
  });
  note(() => {
    assert.strictEqual(
      rate.status,
      0,
      '429 limiter child\n' + (rate.stdout || '') + '\n' + (rate.stderr || '')
    );
  });

  if (failures.length) {
    console.error('api exposure tests FAILED (' + failures.length + ' failures, ' + checks + ' checks)');
    for (const failure of failures) console.error('FAIL: ' + failure);
    process.exit(1);
  }
  console.log('api exposure tests passed (' + checks + ' checks)');
}

function rateOnce(port, agent) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: '127.0.0.1',
      port,
      method: 'GET',
      path: '/api/seo-rl-probe',
      agent,
    }, (res) => {
      res.resume();
      res.on('end', () => {
        const value = res.headers['x-robots-tag'];
        resolve({
          status: res.statusCode,
          robots: Array.isArray(value) ? value.join(', ') : value,
        });
      });
    });
    req.on('error', reject);
    req.end();
  });
}

async function rateLimitMain() {
  if (process.env.NODE_ENV === 'test') {
    throw new Error('rate-limit child must not run with NODE_ENV=test');
  }
  const server = http.createServer(app);
  const agent = new http.Agent({ keepAlive: true, maxSockets: 1 });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  try {
    let threeHundred = null;
    let over = null;
    for (let i = 1; i <= 301; i++) {
      const res = await rateOnce(port, agent);
      if (i === 300) threeHundred = res;
      if (i === 301) over = res;
    }
    assert.strictEqual(threeHundred.status, 404, 'request 300 is still under the production max of 300');
    assert.notStrictEqual(threeHundred.status, 429, 'request 300 must not be rate limited');
    assert.strictEqual(threeHundred.robots, 'noindex', 'request 300 X-Robots-Tag');
    assert.strictEqual(over.status, 429, 'request 301 is a 429 from the unchanged /api limiter');
    assert.strictEqual(over.robots, 'noindex', '429 X-Robots-Tag');
    console.log('rate-limit tag test passed (429 carries noindex, limiter max still 300)');
  } finally {
    agent.destroy();
    await new Promise((resolve) => server.close(resolve));
    try { db.close(); } catch (e) {}
    for (const extra of [dbFile, dbFile + '-wal', dbFile + '-shm']) {
      try { fs.unlinkSync(extra); } catch (e) {}
    }
  }
}

if (rateLimitChild) {
  rateLimitMain().catch((err) => {
    console.error(err);
    process.exit(1);
  });
} else {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
