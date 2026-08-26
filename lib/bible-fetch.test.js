/**
 * Live helloao fetch check for chapter-only refs (Psalm 136, John 1).
 * Run: node lib/bible-fetch.test.js
 */
const { parseReference } = require('./scripture-refs');

async function fetchChapter(reference, translation) {
  const parsed = parseReference(reference);
  if (!parsed) throw new Error(`parse failed: ${reference}`);
  const url = `https://bible.helloao.org/api/${translation}/${parsed.bookCode}/${parsed.chapter}.json`;
  const res = await fetch(url, { headers: { Accept: 'application/json' } });
  if (!res.ok) throw new Error(`${url} -> ${res.status}`);
  const data = await res.json();
  const verses = (data?.chapter?.content || []).filter((i) => i.type === 'verse');
  if (!verses.length) throw new Error(`no verses at ${url}`);
  return verses.length;
}

(async () => {
  const psalm = await fetchChapter('Psalm 136', 'hbo_wlc');
  if (psalm < 20) throw new Error(`Psalm 136 WLC expected a full chapter, got ${psalm} verses`);
  const johnEn = await fetchChapter('John 1', 'BSB');
  if (johnEn < 40) throw new Error(`John 1 BSB expected a full chapter, got ${johnEn} verses`);
  const johnGrc = await fetchChapter('John 1', 'grc_sbl');
  if (johnGrc < 40) throw new Error(`John 1 SBL expected a full chapter, got ${johnGrc} verses`);
  console.log(`bible-fetch.test.js: Psalm 136 WLC=${psalm} vv; John 1 BSB=${johnEn} vv SBL=${johnGrc} vv`);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
