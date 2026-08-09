/**
 * The Word in Context — product brand pack (downloads / trials).
 * Content format: real Bible study questions + short AI answers + CTA.
 */

function envList(name, fallback) {
  const raw = process.env[name] || fallback || '';
  return raw
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

const PUBLIC_URL = (
  process.env.SHARE_SITE_URL ||
  process.env.SITE_URL ||
  process.env.PUBLIC_APP_URL ||
  'https://www.thewordincontext.org'
).replace(/\/$/, '');

/** Canonical bare host users expect to see in posts (with or without www). */
const SITE_HOST = PUBLIC_URL.replace(/^https?:\/\//i, '')
  .replace(/^www\./i, '')
  .toLowerCase() || 'thewordincontext.org';

/** Prefer www in links (matches live site + magic links). */
const CANONICAL_SITE_URL =
  PUBLIC_URL.includes('thewordincontext.org')
    ? 'https://www.thewordincontext.org'
    : PUBLIC_URL;

/**
 * True if caption already mentions our site (bare, www, http, or https).
 */
function captionMentionsWebsite(text, website = CANONICAL_SITE_URL) {
  const lower = String(text || '').toLowerCase();
  if (!lower.trim()) return false;
  const host = String(website || CANONICAL_SITE_URL)
    .replace(/^https?:\/\//i, '')
    .replace(/^www\./i, '')
    .replace(/\/$/, '')
    .toLowerCase();
  if (!host) return false;
  // Match thewordincontext.org with optional www and optional scheme
  if (lower.includes(host)) return true;
  if (lower.includes(`www.${host}`)) return true;
  return false;
}

/**
 * Guarantee the website appears in the caption (own line near the end).
 * Always appends canonical URL if any host form is missing.
 */
function ensureWebsiteInCaption(caption, website = CANONICAL_SITE_URL) {
  const url = (website || CANONICAL_SITE_URL || '').replace(/\/$/, '').trim();
  const body = String(caption || '').trim();
  if (!url) return body;
  if (captionMentionsWebsite(body, url)) {
    // Prefer keeping existing mention; if only bare host without scheme, still OK for social
    return body;
  }
  return body ? `${body}\n\n${url}` : url;
}

/** X/Twitter counts each http(s) URL as 23 chars (t.co). */
function xWeightedLength(text) {
  return String(text || '')
    .replace(/https?:\/\/[^\s]+/gi, 'x'.repeat(23))
    .length;
}

/**
 * Strip our site URLs/hosts from a caption (so we can re-append cleanly).
 */
function stripWebsiteFromCaption(text, website = CANONICAL_SITE_URL) {
  const host = String(website || CANONICAL_SITE_URL)
    .replace(/^https?:\/\//i, '')
    .replace(/^www\./i, '')
    .replace(/\/$/, '')
    .toLowerCase() || SITE_HOST;
  const esc = host.replace(/\./g, '\\.');
  return String(text || '')
    .replace(new RegExp(`https?://(www\\.)?${esc}\\S*`, 'gi'), '')
    .replace(new RegExp(`\\b(www\\.)?${esc}\\b`, 'gi'), '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Truncate for network limits while keeping the website URL at the end.
 * Instagram/Facebook: long captions OK. X: short, URL always last.
 */
function fitCaptionPreservingWebsite(text, network, website = CANONICAL_SITE_URL) {
  const url = (website || CANONICAL_SITE_URL || '').replace(/\/$/, '').trim();
  const n = (network || '').toLowerCase();
  const isX = n === 'x' || n === 'twitter';

  // Non-X: simple ensure + soft char cap (IG allows 2200)
  if (!isX) {
    let t = ensureWebsiteInCaption(String(text || '').trim(), url);
    if (t.length > 2200) {
      const body = stripWebsiteFromCaption(t, url).slice(0, 2100).trim();
      t = ensureWebsiteInCaption(body + (body.length >= 2100 ? '…' : ''), url);
    }
    return t;
  }

  // —— X / Twitter: rebuild so URL is always last and within ~280 weighted chars ——
  // Prefer full https URL (counts as 23 on X, auto-links).
  const xUrl = url || CANONICAL_SITE_URL;
  const URL_WEIGHT = 23;
  const maxWeighted = 270;

  let body = stripWebsiteFromCaption(String(text || '').trim(), xUrl);

  // Pull a single trailing hashtag aside (keep URL last; optional #TheWordInContext)
  let tagLine = '';
  const tagMatch = body.match(/\n(#[\w]+)\s*$/);
  if (tagMatch) {
    tagLine = tagMatch[1];
    body = body.slice(0, -tagMatch[0].length).trim();
  }

  const suffixWeight = 2 + URL_WEIGHT + (tagLine ? 1 + tagLine.length : 0);
  const bodyMax = Math.max(40, maxWeighted - suffixWeight);

  if (xWeightedLength(body) > bodyMax) {
    let cut = body.slice(0, Math.min(body.length, bodyMax + 40));
    while (cut.length > 20 && xWeightedLength(cut) > bodyMax - 1) {
      cut = cut.slice(0, -8);
    }
    const breakAt = Math.max(
      cut.lastIndexOf('\n'),
      cut.lastIndexOf('. '),
      cut.lastIndexOf('! '),
      cut.lastIndexOf('? '),
      cut.lastIndexOf(' ')
    );
    body = (breakAt > 30 ? cut.slice(0, breakAt + (cut[breakAt] === ' ' ? 0 : 1)) : cut).trim();
    if (!body.endsWith('…')) body = `${body.replace(/[.…]+$/, '')}…`;
  }

  function assemble(b, keepTag) {
    const parts = [b];
    if (keepTag && tagLine) parts.push(tagLine);
    parts.push(xUrl);
    return parts.join('\n\n');
  }

  let out = assemble(body, true);
  // If over limit, drop hashtag first (never drop URL)
  if (xWeightedLength(out) > maxWeighted) {
    out = assemble(body, false);
  }
  while (xWeightedLength(out) > maxWeighted && body.length > 40) {
    body = body.slice(0, -12).replace(/\s+\S*$/, '').trim();
    if (!body.endsWith('…')) body = `${body}…`;
    out = assemble(body, false);
  }
  if (xWeightedLength(out) > maxWeighted) {
    const q = body.split('\n')[0].slice(0, 80).trim() || 'Study Scripture in context.';
    out = `${q}\n\n${xUrl}`;
  }
  return out;
}

/**
 * Dedicated short caption for X — always ends with website.
 * Instagram should use full captionIg/caption (not this).
 */
function buildXCaption({ question, caption, captionIg, hashtags } = {}) {
  const url = CANONICAL_SITE_URL;
  const raw = stripWebsiteFromCaption(
    (captionIg || caption || '').trim(),
    url
  );
  let body = raw;
  // Prefer Q: line + first A: paragraph if present (keeps posts scannable on X)
  const qMatch = raw.match(/^Q:\s*.+$/im);
  const aMatch = raw.match(/^A:\s*[\s\S]+?(?=\n\n|\n\(|\nTry |\nStudy |\nAsk |\n#|$)/im);
  if (qMatch) {
    const q = qMatch[0].trim();
    let a = aMatch ? aMatch[0].trim() : '';
    // Shorten A for X
    if (a.length > 160) {
      const cut = a.slice(0, 150);
      const sp = cut.lastIndexOf(' ');
      a = `${(sp > 60 ? cut.slice(0, sp) : cut).trim()}…`;
    }
    body = a ? `${q}\n\n${a}` : q;
  } else if (question) {
    body = `Q: ${String(question).trim()}`;
    if (raw && raw.length < 180) body = `${body}\n\n${raw.slice(0, 160)}`;
  }

  // At most one short hashtag on X (before URL so fit puts URL last)
  const tag = (hashtags || []).find((h) => /^#?TheWordInContext$/i.test(h))
    || (hashtags || [])[0];
  if (tag) {
    const h = tag.startsWith('#') ? tag : `#${tag}`;
    if (!body.toLowerCase().includes(h.toLowerCase())) {
      body = `${body}\n${h}`;
    }
  }

  return fitCaptionPreservingWebsite(body, 'x', url);
}

const CONTENT_BRAND = {
  id: 'wordincontext',
  name: 'The Word in Context',
  productName: 'The Word in Context',
  tagline:
    'Voice-first Scripture study — as close as possible to what the original authors wrote and meant.',
  website: CANONICAL_SITE_URL,
  appUrl: `${CANONICAL_SITE_URL}/app`,
  imageKeys: [
    'share-bg-vertical.jpg',
    'share-bg-parchment.jpg',
    'share-og.png',
    'icon-512.png',
  ],
  voice:
    'Reverent, clear, non-denominational study tone. Prefer literal/formal-equivalence wording and literary context. Short sentences. Never invent verse text. Cite real references when possible. Not a replacement for pastors or congregations. Soft CTA to try the app.',
  hashtags: [
    '#TheWordInContext',
    '#BibleStudy',
    '#Scripture',
    '#BibleApp',
    '#WordStudy',
    '#ChristianLiving',
    '#BibleContext',
  ],
  ctaLines: [
    `Ask deeper questions in The Word in Context — free trial.\n${CANONICAL_SITE_URL}`,
    `Voice-first Scripture study:\n${CANONICAL_SITE_URL}`,
    `Study the text in context — free trial.\n${CANONICAL_SITE_URL}/app`,
    `Try The Word in Context:\n${CANONICAL_SITE_URL}`,
  ],
  /** Pillars are Q&A themes */
  pillars: [
    {
      id: 'word_study',
      label: 'Word study',
      angle:
        'One Greek/Hebrew/Aramaic word or phrase people misread in English; show context briefly.',
    },
    {
      id: 'literary_context',
      label: 'Literary context',
      angle:
        'A verse often quoted alone; answer what the surrounding passage is actually doing.',
    },
    {
      id: 'hard_question',
      label: 'Hard question',
      angle:
        'An honest hard question (justice, suffering, law/gospel) answered carefully from the text—not slogans.',
    },
    {
      id: 'how_to_ask',
      label: 'How to ask',
      angle: 'Teach one better way to ask Scripture questions (who, when, genre, audience).',
    },
    {
      id: 'feature_cta',
      label: 'App feature + CTA',
      angle: 'Show voice-first study or context tools + clear free trial CTA.',
    },
    {
      id: 'myth_bust',
      label: 'Myth bust',
      angle: 'Bust a common misquote or “the Bible says…” without the context.',
    },
    {
      id: 'gospel_passage',
      label: 'Gospel / epistle snapshot',
      angle: 'One short teaching from Gospels or letters with plain context.',
    },
    {
      id: 'founder_note',
      label: 'Why this app',
      angle: 'Honest note: get closer to the wording and context, not hot takes.',
    },
  ],
  preferredHour: Number(process.env.CONTENT_PREFERRED_HOUR || 9),
  timezone: process.env.CONTENT_TIMEZONE || 'America/New_York',
  networks: (() => {
    const allowed = new Set(['facebook', 'instagram', 'linkedin', 'x', 'tiktok']);
    const nets = envList('CONTENT_NETWORKS', 'facebook,instagram')
      .map((s) => (s === 'twitter' ? 'x' : s))
      .filter((n) => allowed.has(n));
    return nets.length ? nets : ['facebook', 'instagram'];
  })(),
};

function publicMediaUrl(imageKey) {
  return `${CANONICAL_SITE_URL}/content-media/${encodeURIComponent(imageKey)}`;
}

module.exports = {
  CONTENT_BRAND,
  publicMediaUrl,
  PUBLIC_URL: CANONICAL_SITE_URL,
  CANONICAL_SITE_URL,
  SITE_HOST,
  captionMentionsWebsite,
  ensureWebsiteInCaption,
  fitCaptionPreservingWebsite,
  buildXCaption,
  xWeightedLength,
  stripWebsiteFromCaption,
};
