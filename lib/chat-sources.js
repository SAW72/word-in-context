/**
 * Normalize live-fetched scripture sources for the chat UI.
 * Only editions that were actually fetched (named translation + verse text)
 * are returned — never invent an edition.
 */
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

module.exports = { normalizeFetchedSources };
