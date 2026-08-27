/**
 * Live helloao.org chapter fetch + verse-content flattening.
 * Apparatus-heavy editions (SBL) mix strings with {noteId} footnote objects.
 * Keep Greek/Hebrew/English letters; drop footnote markers.
 */
const { parseReference } = require('./scripture-refs');

function flattenVerseContent(content) {
  if (content == null) return '';
  if (typeof content === 'string') return content;
  if (typeof content !== 'object') return '';

  if (Array.isArray(content)) {
    return content
      .map((part) => flattenVerseContent(part))
      .filter((part) => part && String(part).trim())
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  // Footnote / apparatus pointer — not verse wording
  const hasNote = content.noteId != null;
  const hasText = typeof content.text === 'string' && content.text;
  const hasNested = Array.isArray(content.content) || Array.isArray(content.words);
  if (hasNote && !hasText && !hasNested) return '';

  if (hasText) return content.text;
  if (content.lineBreak) return ' ';
  if (Array.isArray(content.content)) return flattenVerseContent(content.content);
  if (Array.isArray(content.words)) return flattenVerseContent(content.words);
  return '';
}

function verseNumber(item) {
  const n = Number(item && item.number);
  return Number.isFinite(n) ? n : NaN;
}

async function fetchBiblePassage(reference, translation = 'BSB', opts = {}) {
  try {
    const parsed = parseReference(reference);
    if (!parsed) return null;

    const { bookCode, bookDisplay, chapter, verseStart, verseEnd, wholeChapter } = parsed;
    const trans = translation;
    const url = `https://bible.helloao.org/api/${trans}/${bookCode}/${chapter}.json`;
    if (!opts.quiet) console.log(`[Bible API] Trying: ${url}`);

    const res = await fetch(url, { headers: { Accept: 'application/json' } });
    const contentType = res.headers.get('content-type') || '';
    if (!res.ok || !contentType.includes('json')) {
      if (!opts.quiet) {
        console.error(`Bible API non-JSON response for: ${url} (status: ${res.status})`);
      }
      return null;
    }

    const data = await res.json();
    const content = data?.chapter?.content;
    if (!Array.isArray(content)) return null;

    const verses = [];
    for (const item of content) {
      const num = verseNumber(item);
      if (item.type !== 'verse' || !Number.isFinite(num)) continue;
      if (num < verseStart || num > verseEnd) continue;
      const verseText = flattenVerseContent(item.content);
      if (verseText) verses.push(`${num}. ${verseText}`);
    }

    if (verses.length === 0) return null;

    const first = verses[0].split('.')[0];
    const last = verses[verses.length - 1].split('.')[0];
    const refLabel = wholeChapter || first !== last
      ? `${bookDisplay} ${chapter}:${first}-${last}`
      : `${bookDisplay} ${chapter}:${first}`;

    return {
      reference: refLabel,
      translation: trans,
      text: verses.join(' '),
      wholeChapter: !!wholeChapter,
    };
  } catch (e) {
    console.error('Bible API fetch error (non-fatal):', e.message);
    if (e.message && e.message.includes('Unexpected token')) {
      console.error('  ^ This usually means we hit an HTML page instead of JSON. Check the [Bible API] Trying line above.');
    }
    return null;
  }
}

/**
 * Same helloao path John uses: BSB English + SBL Greek or WLC Hebrew.
 * Returns null when the original-language block is empty or the fetch fails.
 * Never invent Greek/Hebrew — callers must skip the post.
 */
async function fetchStudyGrounding(reference, opts = {}) {
  if (!reference || !parseReference(reference)) return null;

  const english = await fetchBiblePassage(reference, 'BSB', opts);
  const greek = await fetchBiblePassage(reference, 'grc_sbl', opts);
  const hebrew = await fetchBiblePassage(reference, 'hbo_wlc', opts);

  const originals = [greek, hebrew].filter(
    (p) => p && String(p.text || '').trim()
  );
  if (!originals.length) return null;

  const original = originals[0];
  const englishOk = english && String(english.text || '').trim() ? english : null;

  return {
    reference: (englishOk && englishOk.reference) || original.reference || reference,
    english: englishOk,
    original,
    originals,
  };
}

/** All refs must return a live original; otherwise skip the whole post. */
async function fetchStudyGroundings(references, opts = {}) {
  const refs = Array.isArray(references) ? references : [];
  if (!refs.length) return null;
  const results = [];
  for (const ref of refs) {
    const grounding = await fetchStudyGrounding(ref, opts);
    if (!grounding) return null;
    results.push(grounding);
  }
  return results;
}

module.exports = {
  flattenVerseContent,
  fetchBiblePassage,
  fetchStudyGrounding,
  fetchStudyGroundings,
};
