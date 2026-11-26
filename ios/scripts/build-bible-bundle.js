#!/usr/bin/env node
// Builds the offline Bible text bundled in the Twic iPhone app.
// Source: bible.helloao.org complete.json, the same API the web app reads
// (public/bible-core.js, lib/bible-fetch.js). Verse text is flattened with the
// web app's own flattenVerseContent so native and web show the same words.
// Output: ios/App/App/Bible/<id>.json.zlib (raw DEFLATE, decoded on iOS with
// NSData.decompressed(using: .zlib)) plus manifest.json with SHA-256 values.
// Usage: node ios/scripts/build-bible-bundle.js [--cache /tmp/twic-bible]
// NEVER add ESV. NET is online only (license does not allow bundling here).
'use strict';
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');
const { flattenVerseContent } = require('../../lib/bible-fetch');

const TRANSLATIONS = [
  { id: 'BSB', short: 'BSB', name: 'Berean Standard Bible', license: 'Public domain (dedicated by Bible Hub / Berean Bible, April 2023)', source: 'https://berean.bible/' },
  { id: 'eng_kjv', short: 'KJV', name: 'King James Version', license: 'Public domain outside the UK (eBible.org KJV 2006 edition)', source: 'https://ebible.org/Scriptures/details.php?id=eng-kjv2006' },
  { id: 'eng_asv', short: 'ASV', name: 'American Standard Version (1901)', license: 'Public domain', source: 'https://ebible.org/Scriptures/details.php?id=eng-asv' },
  { id: 'eng_ylt', short: 'YLT', name: "Young's Literal Translation", license: 'Public domain', source: 'https://ebible.org/Scriptures/details.php?id=engylt' },
  { id: 'eng_dby', short: 'DBY', name: 'Darby Translation', license: 'Public domain', source: 'https://ebible.org/Scriptures/details.php?id=engDBY' },
  { id: 'ENGWEBP', short: 'WEB', name: 'World English Bible', license: 'Public domain (World English Bible is not copyrighted)', source: 'https://ebible.org/Scriptures/details.php?id=engwebp' },
];
const FORBIDDEN = /esv/i;

function compact(complete, meta) {
  const books = complete.books.map((b) => ({
    id: b.id,
    name: b.commonName || b.name,
    chapters: b.chapters.map((c) => {
      const verses = new Map();
      for (const item of c.chapter.content || []) {
        if (item.type !== 'verse') continue;
        const n = Number(item.number);
        if (!Number.isFinite(n)) continue;
        const text = flattenVerseContent(item.content);
        if (!text) continue;
        verses.set(n, verses.has(n) ? `${verses.get(n)} ${text}` : text);
      }
      return [...verses.entries()].sort((a, z) => a[0] - z[0]);
    }),
  }));
  return { id: meta.id, short: meta.short, name: meta.name, license: meta.license, source: meta.source, books };
}

async function load(id, cacheDir) {
  const cached = cacheDir && path.join(cacheDir, `${id}.json`);
  if (cached && fs.existsSync(cached)) return { buf: fs.readFileSync(cached), from: cached };
  const url = `https://bible.helloao.org/api/${id}/complete.json`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url} -> ${res.status}`);
  return { buf: Buffer.from(await res.arrayBuffer()), from: url };
}

async function main() {
  const i = process.argv.indexOf('--cache');
  const cacheDir = i > 0 ? process.argv[i + 1] : null;
  const outDir = path.join(__dirname, '..', 'App', 'App', 'Bible');
  fs.mkdirSync(outDir, { recursive: true });
  const manifest = { generatedFrom: 'https://bible.helloao.org/api/<id>/complete.json', default: 'BSB', onlineOnly: ['eng_net'], translations: [] };
  for (const meta of TRANSLATIONS) {
    if (FORBIDDEN.test(meta.id) || FORBIDDEN.test(meta.short)) throw new Error('ESV is never bundled');
    const { buf, from } = await load(meta.id, cacheDir);
    const data = compact(JSON.parse(buf.toString('utf8')), meta);
    const json = Buffer.from(JSON.stringify(data));
    const deflated = zlib.deflateRawSync(json, { level: 9 });
    const file = `${meta.id}.json.zlib`;
    fs.writeFileSync(path.join(outDir, file), deflated);
    const verseCount = data.books.reduce((s, b) => s + b.chapters.reduce((t, c) => t + c.length, 0), 0);
    manifest.translations.push({
      id: meta.id, short: meta.short, name: meta.name, license: meta.license, source: meta.source, file,
      books: data.books.length, verses: verseCount,
      sourceSha256: crypto.createHash('sha256').update(buf).digest('hex'),
      fileSha256: crypto.createHash('sha256').update(deflated).digest('hex'),
      jsonBytes: json.length, fileBytes: deflated.length,
    });
    console.log(`${meta.short}: ${data.books.length} books, ${verseCount} verses, ${deflated.length} bytes (from ${from})`);
  }
  fs.writeFileSync(path.join(outDir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
}

main().catch((e) => { console.error(e); process.exit(1); });
