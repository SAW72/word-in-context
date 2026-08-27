/**
 * Reel card + TTS copy (no ffmpeg/jimp). Video encode stays in video.js.
 */
const ORIGINAL_SCRIPT_RE = /[\u0370-\u03FF\u1F00-\u1FFF\u0590-\u05FF]/;

function replaceOriginalLetters(text, post) {
  let t = String(text || '');
  const words = post.originalWords || (post.originalWord ? [post.originalWord] : []);
  const translits = post.translits || (post.translit ? [post.translit] : []);
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    const spoken = translits[i] || translits[0] || '';
    if (w && spoken) t = t.split(w).join(spoken);
  }
  t = t.replace(/[\u0370-\u03FF\u1F00-\u1FFF\u0590-\u05FF]+/g, () => translits[0] || '');
  return t.replace(/\s+/g, ' ').trim();
}

/** TTS reads the study answer — never a sales/trial line. */
function voiceScriptFromPost(post) {
  const raw = (post.captionIg || post.caption || '').trim();
  const q =
    (raw.match(/^Q:\s*.+$/im) || [])[0] ||
    (post.question ? `Q: ${post.question}` : '');
  const aMatch = raw.match(/^A:\s*[\s\S]+?(?=\n\n|\nRead |\nhttps?:|#|$)/im);
  let a = aMatch ? aMatch[0] : '';
  if (!a && post.englishText) {
    a = `A: ${post.englishText}`;
  }
  let t = [q, a].filter(Boolean).join(' ').trim();
  t = t
    .replace(/https?:\/\/\S+/gi, '')
    .replace(/#[\w]+/g, '')
    .replace(/\bfree\s*trial\b/gi, '')
    .replace(/\btry the (word in context|app)\b/gi, '')
    .replace(/thewordincontext\.org/gi, '')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]+/g, ' ')
    .trim();
  t = replaceOriginalLetters(t, post);
  if (t.length > 420) {
    const cut = t.slice(0, 400);
    const breakAt = Math.max(
      cut.lastIndexOf('. '),
      cut.lastIndexOf('! '),
      cut.lastIndexOf('? '),
      cut.lastIndexOf('\n')
    );
    t = (breakAt > 80 ? cut.slice(0, breakAt + 1) : cut).trim() + '…';
  }
  if (!t) {
    t = post.question
      ? `${post.question} Read the passage in context.`
      : 'Read the passage in context.';
  }
  return t;
}

/** Word-wrap a single line for drawtext (approx by chars). */
function wrapLine(line, maxChars = 28) {
  const words = String(line || '')
    .replace(/\s+/g, ' ')
    .trim()
    .split(' ')
    .filter(Boolean);
  if (!words.length) return [];
  const lines = [];
  let cur = '';
  for (const w of words) {
    const next = cur ? `${cur} ${w}` : w;
    if (next.length <= maxChars) cur = next;
    else {
      if (cur) lines.push(cur);
      cur = w.length > maxChars ? `${w.slice(0, maxChars - 1)}…` : w;
    }
  }
  if (cur) lines.push(cur);
  return lines;
}

/**
 * Multi-line card text burned onto reels.
 * Show Q plus the live original word/verse when fetch succeeded.
 */
function overlayTextFromPost(post) {
  const raw = (post.caption || post.captionIg || '').trim();
  const linesIn = raw
    .split('\n')
    .map((s) => s.trim())
    .filter((s) => s && !s.startsWith('#') && !/^https?:/i.test(s));

  let q =
    linesIn.find((s) => /^Q:\s*/i.test(s)) ||
    (post.question ? `Q: ${post.question}` : '') ||
    linesIn[0] ||
    '';
  q = q.replace(/^Q:\s*/i, 'Q: ').replace(/#[\w]+/g, '').trim();

  const originalWords = (
    post.originalWords ||
    (post.originalWord ? [post.originalWord] : [])
  ).filter(Boolean);
  const originalSnippet = String(post.originalText || '')
    .replace(/\s+/g, ' ')
    .trim();

  const bodyLines = [];
  for (const piece of wrapLine(q, 30).slice(0, 3)) bodyLines.push(piece);
  if (originalWords.length) {
    bodyLines.push('');
    for (const w of originalWords.slice(0, 2)) {
      bodyLines.push(w);
    }
  }
  if (originalSnippet) {
    const clip = originalSnippet.length > 90
      ? `${originalSnippet.slice(0, 88).trim()}…`
      : originalSnippet;
    for (const piece of wrapLine(clip, 28).slice(0, 3)) bodyLines.push(piece);
  }
  if (!bodyLines.length) {
    bodyLines.push('Study Scripture', 'in context');
  }

  bodyLines.push('');
  bodyLines.push('The Word in Context');
  bodyLines.push('thewordincontext.org');

  const capped = bodyLines.slice(0, 12);
  return capped.join('\n') || 'The Word in Context\nthewordincontext.org';
}

function overlayHasOriginalScript(text) {
  return ORIGINAL_SCRIPT_RE.test(String(text || ''));
}

module.exports = {
  voiceScriptFromPost,
  overlayTextFromPost,
  overlayHasOriginalScript,
  wrapLine,
};
