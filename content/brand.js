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

const CONTENT_BRAND = {
  id: 'wordincontext',
  name: 'The Word in Context',
  productName: 'The Word in Context',
  tagline:
    'Voice-first Scripture study — as close as possible to what the original authors wrote and meant.',
  website: PUBLIC_URL,
  appUrl: `${PUBLIC_URL}/app`,
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
    'Ask deeper questions in The Word in Context — free trial.',
    'Voice-first Scripture study: thewordincontext.org',
    'Study the text in context — open the app.',
    'Try The Word in Context: questions, context, original-language insight.',
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
  return `${PUBLIC_URL}/content-media/${encodeURIComponent(imageKey)}`;
}

module.exports = {
  CONTENT_BRAND,
  publicMediaUrl,
  PUBLIC_URL,
};
