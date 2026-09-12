'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');

function read(rel) {
  return fs.readFileSync(path.join(root, rel), 'utf8');
}

function count(haystack, needle) {
  return haystack.split(needle).length - 1;
}

function countTag(html, re) {
  const matches = html.match(re);
  return matches ? matches.length : 0;
}

const marketingPages = [
  ['public/landing.html', 'https://www.thewordincontext.org/'],
  ['public/reader.html', 'https://www.thewordincontext.org/read'],
  ['public/privacy.html', 'https://www.thewordincontext.org/privacy'],
  ['public/terms.html', 'https://www.thewordincontext.org/terms'],
  ['public/instructions.html', 'https://www.thewordincontext.org/instructions.html'],
  ['public/attributions.html', 'https://www.thewordincontext.org/attributions.html'],
];

for (const [file, href] of marketingPages) {
  const html = read(file);
  const canonicals = countTag(html, /<link\s+rel="canonical"/gi);
  assert.strictEqual(canonicals, 1, `${file} must have exactly one canonical`);
  assert.ok(
    html.includes(`<link rel="canonical" href="${href}">`),
    `${file} canonical must be ${href}`
  );
}

const landing = read('public/landing.html');
const ldMatch = landing.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/);
assert.ok(ldMatch, 'homepage must include JSON-LD');
const ld = JSON.parse(ldMatch[1]);
const types = (ld['@graph'] || []).map((n) => n['@type']);
assert.ok(types.includes('Organization'), 'JSON-LD includes Organization');
assert.ok(types.includes('SoftwareApplication'), 'JSON-LD includes SoftwareApplication');
assert.ok(!/"aggregateRating"/i.test(landing), 'must not invent aggregateRating');

const server = read('server.js');
const ogMatch = server.match(/const ogTags = `([\s\S]*?)`;/);
assert.ok(ogMatch, 'landing OG template exists');
assert.ok(!/rel="canonical"/i.test(ogMatch[1]), 'landing OG injection must not add a second canonical');
assert.ok(/og:title/.test(ogMatch[1]), 'landing OG injection still emits og:title');
const injectedLanding = landing.replace('</head>', `${ogMatch[1]}\n</head>`);
assert.strictEqual(
  countTag(injectedLanding, /<link\s+rel="canonical"/gi),
  1,
  'homepage after OG injection still has exactly one canonical'
);

const reader = read('public/reader.html');
assert.strictEqual(countTag(reader, /<h1\b/gi), 1, '/read must have exactly one H1');
assert.ok(reader.includes('property="og:title"'), '/read must have OG tags');
assert.ok(reader.includes('name="twitter:card"'), '/read must have Twitter card tags');
assert.ok(!/noindex/i.test(reader), '/read stays indexable');

const app = read('public/index.html');
assert.ok(
  /<meta\s+name="robots"\s+content="noindex\s*,\s*follow"/i.test(app),
  '/app shell must be noindex,follow'
);

const sitemap = read('public/sitemap.xml');
assert.ok(!sitemap.includes('thewordincontext.org/app'), 'sitemap must not list /app');
assert.ok(sitemap.includes('thewordincontext.org/</loc>'), 'sitemap keeps homepage');
assert.ok(sitemap.includes('thewordincontext.org/read'), 'sitemap keeps /read');

assert.strictEqual(count(read('public/instructions.html'), '<h1>Help &amp; instructions</h1>'), 1);

console.log('seo tests passed');
