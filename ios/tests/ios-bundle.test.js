// Node checks for the Twic iPhone bundle. The Swift tests (ios/App/TwicTests)
// read the same fixtures in ios/fixtures so web and native agree.
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');
const { parseReference } = require('../../lib/scripture-refs');

const root = path.join(__dirname, '..');
const bibleDir = path.join(root, 'App', 'App', 'Bible');
let passed = 0;
function check(name, fn) { fn(); passed += 1; console.log('ok', name); }

const manifest = JSON.parse(fs.readFileSync(path.join(bibleDir, 'manifest.json'), 'utf8'));
const load = (id) => JSON.parse(zlib.inflateRawSync(fs.readFileSync(path.join(bibleDir, `${id}.json.zlib`))));

check('manifest lists exactly BSB KJV ASV YLT DBY WEB, BSB default', () => {
  assert.deepStrictEqual(manifest.translations.map((t) => t.short), ['BSB', 'KJV', 'ASV', 'YLT', 'DBY', 'WEB']);
  assert.strictEqual(manifest.default, 'BSB');
  assert.deepStrictEqual(manifest.onlineOnly, ['eng_net']);
});

check('no ESV anywhere in the iOS tree', () => {
  const hits = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { if (!['vendor', 'build', 'DerivedData', 'tests', 'TwicTests'].includes(e.name)) walk(p); continue; }
      if (/esv/i.test(e.name)) hits.push(p);
      if (/\.(json|swift|plist|md|html|js|yml)$/.test(e.name) && /\bESV\b/.test(fs.readFileSync(p, 'utf8'))) {
        if (!/NEVER (add|include) ESV/i.test(fs.readFileSync(p, 'utf8'))) hits.push(p);
      }
    }
  };
  walk(root);
  assert.deepStrictEqual(hits, []);
});

check('bundle files match manifest SHA-256 and verse counts', () => {
  for (const t of manifest.translations) {
    const buf = fs.readFileSync(path.join(bibleDir, t.file));
    assert.strictEqual(crypto.createHash('sha256').update(buf).digest('hex'), t.fileSha256, t.id);
    const data = load(t.id);
    assert.strictEqual(data.books.length, 66, t.id);
    const n = data.books.reduce((s, b) => s + b.chapters.reduce((x, c) => x + c.length, 0), 0);
    assert.strictEqual(n, t.verses, t.id);
    assert.ok(n > 31000, `${t.id} has ${n} verses`);
  }
});

check('verse fixtures match the bundled text', () => {
  const fx = JSON.parse(fs.readFileSync(path.join(root, 'fixtures', 'bible-verses.json'), 'utf8'));
  for (const v of fx.verses) {
    const p = parseReference(v.reference);
    const book = load(v.translation).books.find((b) => b.id === p.bookCode);
    const hit = (book.chapters[p.chapter - 1] || []).find((x) => x[0] === p.verseStart);
    assert.strictEqual(hit ? hit[1] : null, v.text, `${v.reference} ${v.translation}`);
  }
});

check('scripture-refs fixture matches lib/scripture-refs.js parseReference', () => {
  const fx = JSON.parse(fs.readFileSync(path.join(root, 'fixtures', 'scripture-refs.json'), 'utf8'));
  for (const c of fx.cases) {
    const p = parseReference(c.input);
    const got = p ? { bookCode: p.bookCode, bookDisplay: p.bookDisplay, chapter: p.chapter, verseStart: p.verseStart,
      verseEnd: Number.isFinite(p.verseEnd) ? p.verseEnd : null, wholeChapter: p.wholeChapter } : null;
    assert.deepStrictEqual(got, c.expected, c.input);
  }
});

check('every daily verse resolves in bundled BSB', () => {
  const { references } = JSON.parse(fs.readFileSync(path.join(root, 'App', 'App', 'DailyVerses.json'), 'utf8'));
  assert.ok(references.length >= 30);
  const bsb = load('BSB');
  for (const r of references) {
    const p = parseReference(r);
    assert.ok(p && !p.wholeChapter, r);
    const ch = bsb.books.find((b) => b.id === p.bookCode).chapters[p.chapter - 1];
    for (let v = p.verseStart; v <= p.verseEnd; v++) assert.ok(ch.find((x) => x[0] === v), `${r} v${v}`);
  }
});

check('no purchase links or prices in native sources or offline page', () => {
  const dirs = [path.join(root, 'App', 'App')];
  const bad = /(whop\.com|checkout\.stripe|buy\.stripe|\$\d+\.\d\d)/i;
  for (const d of dirs) {
    for (const f of fs.readdirSync(d, { recursive: true })) {
      const p = path.join(d, String(f));
      if (!/\.(swift|html|plist|json|strings)$/.test(p) || fs.statSync(p).isDirectory()) continue;
      if (path.basename(p) === 'PurchaseGuard.swift') continue; // the blocking rules themselves
      const text = fs.readFileSync(p, 'utf8');
      const lines = text.split('\n').filter((l) => bad.test(l));
      assert.deepStrictEqual(lines, [], p);
    }
  }
});

console.log(`ios-bundle tests: ${passed} passed`);
