/** Extract plain text from helloao.org verse content parts */

export function bibleContentPartText(part) {
  if (!part) return '';
  if (typeof part === 'string') return part;
  if (typeof part !== 'object') return '';
  const hasNote = part.noteId != null;
  const hasText = typeof part.text === 'string' && part.text;
  const hasNested = Array.isArray(part.content) || Array.isArray(part.words);
  if (hasNote && !hasText && !hasNested) return '';
  if (hasText) return part.text;
  if (part.lineBreak) return ' ';
  if (Array.isArray(part.content)) return part.content.map(bibleContentPartText).join(' ');
  if (Array.isArray(part.words)) return part.words.map((w) => w.text || bibleContentPartText(w)).join(' ');
  return '';
}

export function verseTextFromContent(content) {
  if (!Array.isArray(content)) return '';
  return content.map(bibleContentPartText).join(' ').replace(/\s+/g, ' ').trim();
}