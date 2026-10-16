'use strict';
/**
 * X-Robots-Tag on /api, /data, and /admin, and a public /api/health of {ok:true}.
 * Detail stays on GET /api/admin/health behind the existing admin JWT.
 */
const assert = require('assert');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const jwt = require('jsonwebtoken');

const dbFile = path.join(os.tmpdir(), `wic-api-exposure-${process.pid}.db`);
for (const extra of [dbFile, dbFile + '-wal', dbFile + '-shm']) {
  try { fs.unlinkSync(extra); } catch (e) {}
}

process.env.NODE_ENV = 'test';
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
      { path: '/%2e%2e/data/study-lexicon.json', status: 404, robots: undefined, excludes: '"greek"' },
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
      { path: '/%2e%2e/admin.html', status: 404, robots: undefined, excludes: 'id="admin-pass"' },
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
        ['/%2e%2e/admin.html', null],
        ['/%64ata/study-lexicon.json', 'noindex'],
        ['/data%2fstudy-lexicon.json', 'noindex'],
        ['/%2e/data/study-lexicon.json', 'noindex'],
        ['/foo/%2e%2e/data/study-lexicon.json', 'noindex'],
        ['/%2e%2e/data/study-lexicon.json', null],
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
        ['/app', null],
        ['/app/', null],
        ['/APP', null],
        ['/application', null],
        ['/', null],
        ['/read', null],
        ['/read/', null],
        ['/john-popup.js', null],
        ['/reader.css', null],
        ['/api/config?x=1', 'noindex'],
      ];
      for (const [sample, expected] of samples) {
        note(() => {
          assert.strictEqual(seo.robotsTagForPath(sample), expected, 'robotsTagForPath ' + sample);
        });
      }

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

  if (failures.length) {
    console.error('api exposure tests FAILED (' + failures.length + ' failures, ' + checks + ' checks)');
    for (const failure of failures) console.error('FAIL: ' + failure);
    process.exit(1);
  }
  console.log('api exposure tests passed (' + checks + ' checks)');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
