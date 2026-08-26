/**
 * Flatten + live helloao fetch checks.
 * Run: node lib/bible-fetch.test.js
 */
const { parseReference, selectStudyOrderRefs } = require('./scripture-refs');
const { flattenVerseContent, fetchBiblePassage } = require('./bible-fetch');

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

// SBL Matthew 19:9 shape (verified 2026-08-26 against bible.helloao.org)
const MATT_19_9_SBL = [
  'λέγω δὲ ὑμῖν ⸀ὅτι',
  { noteId: 448 },
  'ὃς ἂν ἀπολύσῃ τὴν γυναῖκα αὐτοῦ μὴ ἐπὶ πορνείᾳ καὶ γαμήσῃ ἄλλην μοιχᾶται ⸂καὶ ὁ ἀπολελυμένην γαμήσας μοιχᾶται',
  { noteId: 449 },
  '.',
];

const COR_7_15_SBL = [
  'εἰ δὲ ὁ ἄπιστος χωρίζεται, χωριζέσθω· οὐ δεδούλωται ὁ ἀδελφὸς ἢ ἡ ἀδελφὴ ἐν τοῖς τοιούτοις, ἐν δὲ εἰρήνῃ κέκληκεν ⸀ἡμᾶς',
  { noteId: 90 },
  'ὁ θεός.',
];

const flat = flattenVerseContent(MATT_19_9_SBL);
assert(flat.includes('ἀπολύσῃ'), 'flatten keeps ἀπολύσῃ');
assert(flat.includes('πορνείᾳ') || /porneia/i.test(flat), 'flatten keeps porneia / πορνείᾳ');
assert(flat.includes('μοιχᾶται'), 'flatten keeps μοιχᾶται');
const corFlat = flattenVerseContent(COR_7_15_SBL);
assert(corFlat.includes('δεδούλωται'), 'flatten keeps δεδούλωται');
assert(corFlat.includes('χωρίζεται'), 'flatten keeps χωρίζεται');
assert(!/\b90\b/.test(corFlat), '1 Cor 7:15 flatten drops noteId');
assert(!/\b448\b/.test(flat) && !/\b449\b/.test(flat), 'flatten drops noteId objects');
assert(flattenVerseContent([{ noteId: 1 }, { noteId: 2 }]) === '', 'notes-only is empty');
assert(flattenVerseContent(['keep', { noteId: 1 }, 'text']) === 'keep text', 'drop notes, keep strings');

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

  const grc = await fetchBiblePassage('Matthew 19:9', 'grc_sbl', { quiet: true });
  if (!grc || !String(grc.text || '').trim()) {
    throw new Error('Matthew 19:9 SBL original must be non-empty');
  }
  if (!/ἀπολύσῃ/.test(grc.text) || !/μοιχᾶται/.test(grc.text)) {
    throw new Error(`Matthew 19:9 SBL missing expected Greek: ${grc.text}`);
  }
  // Success test: live SBL original must contain porneia (πορνεία / πορνείας / πορνείᾳ).
  if (!/πορνεί[αάᾳ]ς?/.test(grc.text)) {
    throw new Error(`Matthew 19:9 SBL missing πορνεία / πορνείας: ${grc.text}`);
  }

  const bsb = await fetchBiblePassage('Matthew 19:9', 'BSB', { quiet: true });
  if (!bsb || !String(bsb.text || '').trim()) {
    throw new Error('Matthew 19:9 BSB must be non-empty');
  }
  if (!/immorality|adultery|divorces/i.test(bsb.text)) {
    throw new Error(`Matthew 19:9 BSB unexpected English: ${bsb.text}`);
  }

  const corGrc = await fetchBiblePassage('1 Corinthians 7:15', 'grc_sbl', { quiet: true });
  if (!corGrc || !String(corGrc.text || '').trim()) {
    throw new Error('1 Corinthians 7:15 SBL original must be non-empty');
  }
  if (!/δεδούλωται/.test(corGrc.text) || !/χωρίζεται/.test(corGrc.text)) {
    throw new Error(`1 Corinthians 7:15 SBL missing expected Greek: ${corGrc.text}`);
  }

  const corBsb = await fetchBiblePassage('1 Corinthians 7:15', 'BSB', { quiet: true });
  if (!corBsb || !String(corBsb.text || '').trim()) {
    throw new Error('1 Corinthians 7:15 BSB must be non-empty');
  }
  if (!/bound|bondage|not under/i.test(corBsb.text)) {
    throw new Error(`1 Corinthians 7:15 BSB unexpected English: ${corBsb.text}`);
  }

  const divorceStudy = selectStudyOrderRefs(
    'If a spouse commits adultery and they divorce, is the innocent party free to remarry?'
  );
  for (const ref of ['Matthew 19:9', '1 Corinthians 7:15']) {
    if (!divorceStudy.fetchRefs.includes(ref)) {
      throw new Error(`study-order fetchRefs omitted ${ref}: ${divorceStudy.fetchRefs.join(', ')}`);
    }
    const live = await fetchBiblePassage(ref, 'grc_sbl', { quiet: true });
    if (!live || !String(live.text || '').trim()) {
      throw new Error(`study-order live SBL empty for ${ref}`);
    }
  }

  console.log(`bible-fetch.test.js: Psalm 136 WLC=${psalm} vv; John 1 BSB=${johnEn} vv SBL=${johnGrc} vv; Matt 19:9 + 1 Cor 7:15 SBL+BSB ok`);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
