/** Extract plain text from helloao.org verse content parts */

export function bibleContentPartText(part) {
  if (!part) return '';
  if (typeof part === 'string') return part;
  if (part.text) return part.text;
  if (part.lineBreak) return ' ';
  if (Array.isArray(part.words)) return part.words.map((w) => w.text || '').join(' ');
  return '';
}

export function verseTextFromContent(content) {
  if (!Array.isArray(content)) return '';
  return content.map(bibleContentPartText).join(' ').replace(/\s+/g, ' ').trim();
}