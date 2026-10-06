#!/usr/bin/env node
/**
 * Boot the server with dummy env (no real secrets) and check key routes.
 * Used by .github/workflows/ci.yml.
 */
'use strict';

const http = require('http');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const port = Number(process.env.SMOKE_PORT || 8791);
const root = path.join(__dirname, '..');

function get(pathname) {
  return new Promise((resolve, reject) => {
    const req = http.get(
      { hostname: '127.0.0.1', port, path: pathname, timeout: 10000 },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          resolve({
            status: res.statusCode,
            body: Buffer.concat(chunks).toString('utf8'),
          });
        });
      }
    );
    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('timeout ' + pathname));
    });
  });
}

function serverExitError(serverExit) {
  if (!serverExit || !serverExit.exited) return null;
  const why = serverExit.signal ? 'signal ' + serverExit.signal : 'code ' + serverExit.code;
  return new Error('server exited (' + why + ')');
}

async function waitForHealth(serverExit) {
  const start = Date.now();
  let lastErr;
  while (Date.now() - start < 20000) {
    const exited = serverExitError(serverExit);
    if (exited) throw exited;
    try {
      const res = await get('/api/health');
      if (res.status === 200) return res;
      lastErr = new Error('health status ' + res.status);
    } catch (err) {
      const died = serverExitError(serverExit);
      if (died) throw died;
      lastErr = err;
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  const exited = serverExitError(serverExit);
  if (exited) throw exited;
  throw lastErr || new Error('server did not become healthy');
}

function assertStatus(pathname, res, expected) {
  if (res.status !== expected) {
    throw new Error(pathname + ' returned ' + res.status + ', expected ' + expected);
  }
  console.log(pathname, res.status);
}

async function main() {
  const child = spawn(process.execPath, ['server.js'], {
    cwd: root,
    env: {
      PATH: process.env.PATH || '',
      HOME: process.env.HOME || '',
      NODE_ENV: 'test',
      PORT: String(port),
      WIC_DB_PATH: process.env.WIC_DB_PATH || path.join(os.tmpdir(), `wic-smoke-${process.pid}.db`),
      JWT_SECRET: 'ci-smoke-jwt-secret-not-a-real-secret-32',
      ADMIN_PASSWORD: 'ci-smoke-admin-password',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let logs = '';
  const serverExit = { code: null, signal: null, exited: false };
  child.stdout.on('data', (d) => { logs += d.toString(); });
  child.stderr.on('data', (d) => { logs += d.toString(); });
  child.on('exit', (code, signal) => {
    serverExit.exited = true;
    serverExit.code = code;
    serverExit.signal = signal;
  });

  const stop = () => {
    if (child.exitCode == null && !child.killed) child.kill('SIGTERM');
  };

  try {
    const health = await waitForHealth(serverExit);
    const parsed = JSON.parse(health.body);
    if (parsed.ok !== true) throw new Error('health JSON ok is not true');
    assertStatus('/api/health', health, 200);

    const home = await get('/');
    assertStatus('/', home, 200);
    if (!/<html/i.test(home.body)) throw new Error('/ did not return HTML');

    const attributions = await get('/attributions.html');
    assertStatus('/attributions.html', attributions, 200);
    if (!/attribution/i.test(attributions.body)) throw new Error('/attributions.html body missing');

    const instructions = await get('/instructions.html');
    assertStatus('/instructions.html', instructions, 200);
    if (!/instructions/i.test(instructions.body)) throw new Error('/instructions.html body missing');

    const appPage = await get('/app');
    assertStatus('/app', appPage, 200);
    if (!/<html/i.test(appPage.body)) throw new Error('/app did not return HTML');

    const readPage = await get('/read');
    assertStatus('/read', readPage, 200);
    if (!/<html/i.test(readPage.body)) throw new Error('/read did not return HTML');

    const admin = await get('/admin');
    assertStatus('/admin', admin, 200);
    if (!/<html/i.test(admin.body)) throw new Error('/admin did not return HTML');

    const adminUsers = await get('/api/admin/users');
    assertStatus('/api/admin/users', adminUsers, 401);
    let adminJson = null;
    try { adminJson = JSON.parse(adminUsers.body); } catch (e) {}
    if (!adminJson || !adminJson.error) throw new Error('/api/admin/users did not return an error');

    const died = serverExitError(serverExit);
    if (died) throw died;

    console.log('smoke routes passed');
  } catch (err) {
    console.error(err && err.stack || err);
    console.error(logs.slice(-4000));
    process.exitCode = 1;
  } finally {
    stop();
    await new Promise((resolve) => {
      if (child.exitCode != null) return resolve();
      child.once('exit', resolve);
      setTimeout(resolve, 3000);
    });
  }
}

main();
