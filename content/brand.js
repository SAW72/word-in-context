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

/**
 * Truncate for network limits while keeping the website URL at the end.
 */
function fitCaptionPreservingWebsite(text, network, website = CANONICAL_SITE_URL) {
  const url = (website || CANONICAL_SITE_URL || '').replace(/\/$/, '').trim();
  const n = (network || '').toLowerCase();
  let t = ensureWebsiteInCaption(String(text || '').trim(), url);

  let max = 2200;
  if (n === 'x' || n === 'twitter') max = 270;
  if (t.length <= max) return t;

  // Reserve room for blank line + URL (+ ellipsis)
  const reserve = url ? url.length + 4 : 1;
  const bodyMax = Math.max(40, max - reserve);
  const cut = t.slice(0, bodyMax);
  // Prefer cutting before a trailing URL we just ensured, so we don't double-append
  let body = cut;
  if (url) {
    const withoutUrl = t
      .replace(new RegExp(`\\n*https?://(www\\.)?${SITE_HOST.replace(/\./g, '\\.')}\\S*`, 'gi'), '')
      .replace(new RegExp(`\\n*(www\\.)?${SITE_HOST.replace(/\./g, '\\.')}\\S*`, 'gi'), '')
      .trim();
    const cutBody = withoutUrl.slice(0, bodyMax);
    const breakAt = Math.max(
      cutBody.lastIndexOf('\n'),
      cutBody.lastIndexOf('. '),
      cutBody.lastIndexOf('! '),
      cutBody.lastIndexOf('? ')
    );
    body = (breakAt > 40 ? cutBody.slice(0, breakAt + 1) : cutBody).trim();
    if (body.length > bodyMax - 1) body = body.slice(0, bodyMax - 1).trim();
    if (!body.endsWith('…') && withoutUrl.length > body.length) body = `${body}…`;
    return ensureWebsiteInCaption(body, url);
  }

  const breakAt = Math.max(
    cut.lastIndexOf('\n'),
    cut.lastIndexOf('. '),
    cut.lastIndexOf('! '),
    cut.lastIndexOf('? ')
  );
  body = (breakAt > 80 ? cut.slice(0, breakAt + 1) : cut).trim();
  return `${body}…`;
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
};
