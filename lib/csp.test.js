const assert = require('assert');
const { ENFORCED_CSP, REPORT_ONLY_CSP } = require('./csp');

const EXPECTED_ENFORCED =
  "default-src 'self' 'unsafe-inline' 'unsafe-eval' blob: data: https: http: ws: wss:; " +
  "connect-src 'self' https: http: ws: wss:; " +
  "media-src 'self' blob: data: https:; " +
  "img-src 'self' data: https:; " +
  "script-src 'self' 'unsafe-inline' 'unsafe-eval' https:; " +
  "style-src 'self' 'unsafe-inline' https:;";

assert.strictEqual(ENFORCED_CSP, EXPECTED_ENFORCED, 'enforced CSP must stay exactly as it was');

function directive(policy, name) {
  const part = policy.split(';').map((s) => s.trim()).find((s) => s.startsWith(name + ' '));
  assert.ok(part, 'missing directive ' + name);
  return part;
}

const script = directive(REPORT_ONLY_CSP, 'script-src');
const scriptSources = script.split(/\s+/).slice(1);
assert.ok(scriptSources.includes("'wasm-unsafe-eval'"), 'report-only script-src uses wasm-unsafe-eval');
assert.ok(!scriptSources.includes("'unsafe-eval'"), 'report-only script-src does not allow unsafe-eval');
assert.ok(!scriptSources.includes("'unsafe-inline'"), 'report-only script-src does not allow unsafe-inline');
assert.ok(script.includes('https://cdn.jsdelivr.net'), 'ffmpeg.wasm CDN stays allowed');
assert.ok(!scriptSources.includes('blob:'), 'script-src does not need blob workers');

assert.ok(directive(REPORT_ONLY_CSP, 'style-src').includes("'unsafe-inline'"), 'inline style attributes stay allowed');
assert.ok(!/\bhttp:/.test(REPORT_ONLY_CSP), 'report-only drops http:');
assert.ok(!/\bws:/.test(REPORT_ONLY_CSP), 'report-only drops ws:');
assert.ok(!/\bwss:/.test(REPORT_ONLY_CSP), 'report-only drops wss:');
assert.ok(!/report-uri|report-to/i.test(REPORT_ONLY_CSP), 'no report endpoint was added');

const connect = directive(REPORT_ONLY_CSP, 'connect-src');
for (const host of [
  'https://bible.helloao.org',
  'https://audio.bible.helloao.org',
  'https://cdn.jsdelivr.net',
  'https://api.x.ai',
  'https://fonts.googleapis.com',
  'https://fonts.gstatic.com',
]) {
  assert.ok(connect.includes(host), 'connect-src keeps ' + host);
}
assert.ok(directive(REPORT_ONLY_CSP, 'media-src').includes('https://audio.bible.helloao.org'));
assert.ok(directive(REPORT_ONLY_CSP, 'font-src').includes('https://fonts.gstatic.com'));
assert.ok(directive(REPORT_ONLY_CSP, 'worker-src').includes('https://cdn.jsdelivr.net'));
assert.ok(directive(REPORT_ONLY_CSP, 'worker-src').includes("'self'"));
assert.ok(directive(REPORT_ONLY_CSP, 'style-src').includes('https://fonts.googleapis.com'));

console.log('csp tests passed');
