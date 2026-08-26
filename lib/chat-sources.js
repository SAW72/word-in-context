/**
 * Normalize live-fetched scripture sources for the chat UI.
 * Only editions that were actually fetched (named translation + verse text)
 * are returned — never invent an edition.
 */

/** Live SBL Matthew 19:9 uses dative πορνείᾳ; accept πορνεία / πορνείας too. */
const PORNEIA_LIVE_RE = /πορνεί[αάᾳ]ς?/;

function classifyGroundingLabel(translation) {
  const t = String(translation || '');
  if (/grc/i.test(t)) return 'ORIGINAL GREEK TEXT';
  if (/hbo|heb.*wlc/i.test(t)) return 'ORIGINAL HEBREW TEXT';
  return 'ACCURATE BIBLE TEXT';
}

function formatGroundingBlocks(passages, getDisplayTrans) {
  if (!Array.isArray(passages) || !passages.length) return '';
  const nameOf = typeof getDisplayTrans === 'function'
    ? getDisplayTrans
    : (t) => t || 'Unknown';
  return passages.map((p) => {
    const disp = nameOf(p.translation);
    const label = classifyGroundingLabel(p.translation);
    return `\n\n[${label} — ${p.reference} (${disp})]\n${p.text}`;
  }).join('');
}

function hasOriginalGreekBlock(blocks, reference) {
  if (!blocks || !reference) return false;
  const escaped = String(reference).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`\\[ORIGINAL GREEK TEXT — ${escaped}\\b`).test(blocks);
}

function normalizeFetchedSources(sources) {
  if (!Array.isArray(sources)) return [];
  const seen = new Set();
  const out = [];
  for (const s of sources) {
    if (!s || typeof s !== 'object') continue;
    const reference = String(s.reference || '').trim();
    const translation = String(s.translation || '').trim();
    const text = String(s.text || '').trim();
    const rawId = String(s.rawId || '').trim();
    if (!reference || !translation || !text) continue;
    const key = `${reference}|${translation}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const entry = { reference, translation, text };
    if (rawId) entry.rawId = rawId;
    out.push(entry);
  }
  return out;
}

module.exports = {
  normalizeFetchedSources,
  classifyGroundingLabel,
  formatGroundingBlocks,
  hasOriginalGreekBlock,
  PORNEIA_LIVE_RE,
};
