const {
  CONTENT_BRAND,
  publicMediaUrl,
  ensureWebsiteInCaption,
  CANONICAL_SITE_URL,
} = require('./brand');
const {
  loadQueue,
  listPosts,
  upsertPosts,
  removePostsByIds,
  nextImage,
  nextSeed,
  newId,
} = require('./queue');
const { STUDY_SEEDS, getSeedById, getSeedByRef } = require('./seeds');
const { fetchStudyGroundings } = require('../lib/bible-fetch');
const { classifyGroundingLabel } = require('../lib/chat-sources');

const BANNED_MARKETING_RE =
  /free\s*trial|#BibleApp\b|#ChristianLiving\b|feature_cta|founder_note|try the (word in context|app)/i;

const BROCHURE_HOOKS = [
  'why does context matter when reading a single verse',
  'q: word study?',
];

function ymdInTz(d, tz) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(d);
}

function scheduledAtForDay(day, hour, tz) {
  const ymd = ymdInTz(day, tz);
  const [y, m, d] = ymd.split('-').map(Number);
  const probe = new Date(Date.UTC(y, m - 1, d, 12, 0, 0));
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    timeZoneName: 'shortOffset',
  }).formatToParts(probe);
  const tzName = parts.find((p) => p.type === 'timeZoneName')?.value || 'GMT';
  const mOff = tzName.match(/GMT([+-]\d{1,2})(?::?(\d{2}))?/);
  let offsetMin = 0;
  if (mOff) {
    const h = Number(mOff[1]);
    const mins = Number(mOff[2] || 0);
    offsetMin = h * 60 + Math.sign(h || 1) * mins;
  }
  const utcMs = Date.UTC(y, m - 1, d, hour, 0, 0) - offsetMin * 60_000;
  return new Date(utcMs).toISOString();
}

function brandLink(brand) {
  return (
    brand.website ||
    CANONICAL_SITE_URL ||
    'https://www.thewordincontext.org'
  ).replace(/\/$/, '');
}

/** Strip Hebrew/Aramaic points and cantillation so we can find חסד / שאול in WLC. */
function stripSemiticMarks(text) {
  return String(text || '').normalize('NFD').replace(/[\u0591-\u05C7]/g, '');
}

function stripVersePrefix(text) {
  return String(text || '')
    .replace(/^\s*\d+\.\s*/, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function clipText(text, max = 160) {
  const t = String(text || '').trim();
  if (t.length <= max) return t;
  const cut = t.slice(0, max - 1);
  const sp = cut.lastIndexOf(' ');
  return `${(sp > 40 ? cut.slice(0, sp) : cut).trim()}…`;
}

function editionLabel(translation) {
  const kind = classifyGroundingLabel(translation);
  if (kind === 'ORIGINAL GREEK TEXT') return 'SBL Greek';
  if (kind === 'ORIGINAL HEBREW TEXT') return 'WLC Hebrew';
  return 'BSB';
}

function extractFocusWord(originalText, passage) {
  const raw = String(originalText || '');
  if (!raw.trim()) return '';
  if (passage.focusRe) {
    const direct = raw.match(passage.focusRe);
    if (direct) return direct[0];
  }
  const needle = String(passage.focusNeedle || '').trim();
  if (needle) {
    const tokens = raw.split(/\s+/);
    for (const tok of tokens) {
      const folded = stripSemiticMarks(tok);
      if (folded.includes(needle) || tok.includes(needle)) {
        return tok.replace(/[׃.,;:]+$/g, '');
      }
    }
    if (stripSemiticMarks(raw).includes(needle)) {
      const idx = stripSemiticMarks(raw).indexOf(needle);
      if (idx >= 0) return needle;
    }
  }
  return '';
}

function collectStudyWords(seed, groundings) {
  const words = [];
  for (let i = 0; i < seed.passages.length; i++) {
    const passage = seed.passages[i];
    const g = groundings[i];
    if (!g || !g.original || !String(g.original.text || '').trim()) {
      return null;
    }
    const word = extractFocusWord(g.original.text, passage);
    if ((passage.focusRe || passage.focusNeedle) && !word) return null;
    words.push({
      ref: g.reference || passage.ref,
      word,
      translit: passage.translit || '',
      originalText: stripVersePrefix(g.original.text),
      englishText: g.english ? stripVersePrefix(g.english.text) : '',
      translation: g.original.translation,
      edition: editionLabel(g.original.translation),
    });
  }
  return words;
}

function hasLiveOriginal(groundings) {
  return (
    Array.isArray(groundings) &&
    groundings.length > 0 &&
    groundings.every((g) => g && g.original && String(g.original.text || '').trim())
  );
}

function captionHasBannedCopy(text) {
  const t = String(text || '');
  if (BANNED_MARKETING_RE.test(t)) return true;
  const lower = t.toLowerCase();
  return BROCHURE_HOOKS.some((h) => lower.includes(h));
}

/**
 * Build a caption from live fetched blocks only.
 * Returns null if original-language text is missing — caller must skip.
 */
function buildStudyCopy(seed, groundings, brand = CONTENT_BRAND) {
  if (!seed || !hasLiveOriginal(groundings)) return null;
  if (groundings.length < seed.passages.length) return null;

  const words = collectStudyWords(seed, groundings);
  if (!words) return null;

  const link = brandLink(brand);
  const answerParts = [];
  for (const w of words) {
    if (w.word) {
      answerParts.push(
        `${w.ref} uses ${w.word} in the live ${w.edition}.`
      );
    }
    answerParts.push(`“${clipText(w.originalText, 180)}”`);
    if (w.englishText) {
      answerParts.push(`BSB: “${clipText(w.englishText, 160)}”`);
    }
  }

  const refs = words.map((w) => w.ref);
  const invite =
    refs.length === 1
      ? `Read ${refs[0]} in context.`
      : `Read ${refs.join(' and ')} in context.`;

  const caption = ensureWebsiteInCaption(
    [`Q: ${seed.question}`, '', `A: ${answerParts.join(' ')}`, '', invite].join(
      '\n'
    ),
    link
  );

  if (captionHasBannedCopy(caption)) return null;
  for (const w of words) {
    if (w.word && !caption.includes(w.word)) return null;
  }

  const originalWords = words.map((w) => w.word).filter(Boolean);
  const translits = words.map((w) => w.translit).filter(Boolean);

  return {
    question: seed.question,
    caption,
    captionIg: caption.slice(0, 2100),
    hashtags: (brand.hashtags || []).slice(0, 6),
    cta: invite,
    seedId: seed.id,
    pillarId: seed.pillarId || 'word_study',
    reference: refs.join('; '),
    originalWord: originalWords[0] || '',
    originalWords,
    originalText: words.map((w) => w.originalText).join(' '),
    translit: translits[0] || '',
    translits,
    englishText: words.map((w) => w.englishText).filter(Boolean).join(' '),
  };
}

function withTimeout(promise, ms, label) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(
      () => reject(new Error(`${label} timed out after ${ms}ms`)),
      ms
    );
    promise.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      }
    );
  });
}

function liveBlocksForPrompt(seed, groundings) {
  return seed.passages
    .map((passage, i) => {
      const g = groundings[i];
      if (!g) return '';
      const orig = g.original;
      const eng = g.english;
      const label = classifyGroundingLabel(orig.translation);
      return [
        `SEED ${seed.id} — Q: ${seed.question}`,
        `[${label} — ${orig.reference || passage.ref} (${orig.translation})]`,
        orig.text,
        eng
          ? `[ACCURATE BIBLE TEXT — ${eng.reference} (BSB)]\n${eng.text}`
          : '',
      ]
        .filter(Boolean)
        .join('\n');
    })
    .join('\n\n');
}

async function polishCopyWithGrok(brand, slots) {
  const apiKey = (process.env.XAI_API_KEY || '').trim();
  if (!apiKey || !slots.length) return slots.map(() => null);

  const baseUrl = (process.env.XAI_BASE_URL || 'https://api.x.ai/v1').replace(
    /\/$/,
    ''
  );
  const model = process.env.XAI_MODEL || 'grok-4.3';
  const link = brandLink(brand);

  const system = `You write short social posts for ${brand.productName}.
You may ONLY quote Greek/Hebrew letters that appear in the LIVE FETCHED blocks below. Never invent spellings.
No free trial. No app feature ads. No #BibleApp. No #ChristianLiving.

FORMAT for every post:
1) First line: Q: <the study question — you may tighten wording, keep the same verse>
2) Then A: <2–4 short sentences that quote the live original letters when that is the point, then a short BSB phrase>
3) One line inviting the reader to read the passage in context.
4) The website URL alone on the LAST line:
${link}

Return ONLY valid JSON:
{"posts":[{"question":"...","caption":"...","captionIg":"...","hashtags":["#TheWordInContext"],"cta":"..."}]}
posts length MUST equal ${slots.length} in order.`;

  const user = slots
    .map((s, i) => `${i + 1}.\n${liveBlocksForPrompt(s.seed, s.groundings)}`)
    .join('\n\n----\n\n');

  try {
    const res = await withTimeout(
      fetch(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model,
          temperature: 0.4,
          max_tokens: 4000,
          messages: [
            { role: 'system', content: system },
            { role: 'user', content: user },
          ],
        }),
      }),
      60_000,
      'Grok week generate'
    );
    if (!res.ok) {
      const t = await res.text();
      throw new Error(`xAI HTTP ${res.status}: ${t.slice(0, 200)}`);
    }
    const json = await res.json();
    const text = json.choices?.[0]?.message?.content || '{}';
    const cleaned = text
      .replace(/^```json\s*/i, '')
      .replace(/```\s*$/i, '')
      .trim();
    const parsed = JSON.parse(cleaned);
    const arr = Array.isArray(parsed)
      ? parsed
      : Array.isArray(parsed.posts)
        ? parsed.posts
        : [];
    return slots.map((s, i) => {
      const p = arr[i];
      const fallback = buildStudyCopy(s.seed, s.groundings, brand);
      if (!p?.caption?.trim() || !fallback) return fallback;
      const caption = ensureWebsiteInCaption(p.caption, link);
      const captionIg = ensureWebsiteInCaption(p.captionIg || p.caption, link);
      const mustHave = fallback.originalWords || [];
      const ok =
        mustHave.every((w) => caption.includes(w)) &&
        !captionHasBannedCopy(caption);
      if (!ok) return fallback;
      return {
        ...fallback,
        question: p.question || fallback.question,
        caption,
        captionIg,
        hashtags: Array.isArray(p.hashtags) && p.hashtags.length
          ? p.hashtags.filter((h) => !/#BibleApp|#ChristianLiving/i.test(h))
          : fallback.hashtags,
        cta: p.cta && !BANNED_MARKETING_RE.test(p.cta) ? p.cta : fallback.cta,
      };
    });
  } catch (err) {
    console.warn('[content] grok polish failed, using fetched templates', err.message);
    return slots.map((s) => buildStudyCopy(s.seed, s.groundings, brand));
  }
}

/**
 * Fetch live BSB + original for a seed. Null if any original block is empty.
 */
async function fetchSeedGroundings(seed, opts = {}) {
  if (!seed || !Array.isArray(seed.passages) || !seed.passages.length) {
    return null;
  }
  const refs = seed.passages.map((p) => p.ref);
  return fetchStudyGroundings(refs, { quiet: true, ...opts });
}

/**
 * Helper used by tests and smoke: one grounded post for a seed or reference.
 * Returns null when the original-language fetch is empty.
 */
async function buildHelperPost(seedOrRef, brand = CONTENT_BRAND) {
  const seed =
    typeof seedOrRef === 'string'
      ? getSeedById(seedOrRef) || getSeedByRef(seedOrRef)
      : seedOrRef;
  if (!seed) return null;
  const groundings = await fetchSeedGroundings(seed);
  if (!groundings) return null;
  return buildStudyCopy(seed, groundings, brand);
}

async function pickGroundedSlot(brand, usedSeedIds, warnings) {
  for (let attempt = 0; attempt < STUDY_SEEDS.length; attempt++) {
    const seed = nextSeed(STUDY_SEEDS);
    if (!seed || usedSeedIds.has(seed.id)) continue;
    usedSeedIds.add(seed.id);
    const groundings = await fetchSeedGroundings(seed);
    if (!groundings) {
      warnings.push(
        `Skip ${seed.id}: original-language fetch empty or failed`
      );
      continue;
    }
    const copy = buildStudyCopy(seed, groundings, brand);
    if (!copy) {
      warnings.push(`Skip ${seed.id}: could not quote live original`);
      continue;
    }
    return { seed, groundings, copy };
  }
  return null;
}

async function generatePosts({ days = 7, mode = 'replace' } = {}) {
  const brand = CONTENT_BRAND;
  const nDays = Math.max(1, Math.min(days, 14));
  const start = new Date();
  const warnings = [];
  const existing = loadQueue().posts;
  const byDate = new Map(existing.map((p) => [p.targetDate, p]));
  const removeIds = new Set();
  const dateSlots = [];

  for (let i = 0; i < nDays; i++) {
    const day = new Date(start.getTime() + i * 86400000);
    const targetDate = ymdInTz(day, brand.timezone);
    const prev = byDate.get(targetDate);
    if (prev) {
      if (mode === 'skip') {
        warnings.push(`Skip ${targetDate}: already ${prev.status}`);
        continue;
      }
      if (mode === 'replace') {
        if (prev.status === 'scheduled' || prev.status === 'posted') {
          warnings.push(`Skip ${targetDate}: already ${prev.status}`);
          continue;
        }
        removeIds.add(prev.id);
        warnings.push(`Refreshing ${targetDate} (was ${prev.status})`);
      } else if (mode === 'force') {
        removeIds.add(prev.id);
      }
    }
    dateSlots.push({
      day,
      targetDate,
      imageKey: nextImage(brand),
    });
  }

  if (removeIds.size) removePostsByIds([...removeIds]);

  if (!dateSlots.length) {
    const pending = existing.filter((p) =>
      ['queued', 'failed', 'draft'].includes(p.status)
    ).length;
    return {
      posts: [],
      warnings: [
        ...warnings,
        pending
          ? `${pending} post(s) ready — review, then Publish if you choose.`
          : 'Nothing to generate.',
      ],
    };
  }

  const usedSeedIds = new Set();
  const grounded = [];
  for (const dateSlot of dateSlots) {
    const picked = await pickGroundedSlot(brand, usedSeedIds, warnings);
    if (!picked) {
      warnings.push(
        `Skip ${dateSlot.targetDate}: no seed with a live original-language fetch`
      );
      continue;
    }
    grounded.push({ ...dateSlot, ...picked });
  }

  if (!grounded.length) {
    return {
      posts: [],
      warnings: [
        ...warnings,
        'No posts generated — every seed lacked a live original-language block.',
      ],
    };
  }

  const polished = await polishCopyWithGrok(brand, grounded);
  const now = new Date().toISOString();
  const link = brandLink(brand);
  const created = [];

  for (let i = 0; i < grounded.length; i++) {
    const slot = grounded[i];
    const copy = polished[i] || slot.copy;
    if (!copy || !copy.caption) {
      warnings.push(
        `Skip ${slot.targetDate} (${slot.seed.id}): copy missing live original`
      );
      continue;
    }
    const hashtags = (copy.hashtags || brand.hashtags || []).filter(
      (h) => !/#BibleApp|#ChristianLiving/i.test(h)
    );
    created.push({
      id: newId(),
      brandId: brand.id,
      pillarId: copy.pillarId || slot.seed.pillarId,
      seedId: slot.seed.id,
      status: 'queued',
      targetDate: slot.targetDate,
      scheduledAt: scheduledAtForDay(
        slot.day,
        brand.preferredHour,
        brand.timezone
      ),
      networks: [...brand.networks],
      caption: ensureWebsiteInCaption(copy.caption, link),
      captionIg: ensureWebsiteInCaption(copy.captionIg || copy.caption, link),
      question: copy.question || slot.seed.question,
      hashtags,
      imageKey: slot.imageKey,
      imageUrl: publicMediaUrl(slot.imageKey),
      cta: copy.cta || 'Read the passage yourself in context.',
      reference: copy.reference,
      originalWord: copy.originalWord,
      originalWords: copy.originalWords,
      originalText: copy.originalText,
      translit: copy.translit,
      translits: copy.translits,
      englishText: copy.englishText,
      createdAt: now,
      updatedAt: now,
    });
  }

  if (created.length) upsertPosts(created);
  warnings.push(
    'Captions built from live BSB + SBL Greek / WLC Hebrew. Not published to Buffer.'
  );
  return { posts: created, warnings };
}

function buildCopyPack(posts) {
  return posts
    .map((p, i) =>
      [
        `=== Post ${i + 1} · ${p.targetDate} · ${p.pillarId} ===`,
        `When: ${p.scheduledAt}`,
        `Q: ${p.question || ''}`,
        p.reference ? `Ref: ${p.reference}` : '',
        p.originalWord ? `Original: ${p.originalWord}` : '',
        `Image: ${p.imageKey}`,
        p.imageUrl ? `Image URL: ${p.imageUrl}` : '',
        '',
        '— Facebook —',
        p.caption,
        '',
        '— Instagram —',
        p.captionIg || p.caption,
        '',
        (p.hashtags || []).join(' '),
        p.cta ? `Invite: ${p.cta}` : '',
        '',
      ]
        .filter(Boolean)
        .join('\n')
    )
    .join('\n');
}

function countByStatus() {
  const out = {};
  for (const p of listPosts({ limit: 200 })) {
    out[p.status] = (out[p.status] || 0) + 1;
  }
  return out;
}

module.exports = {
  generatePosts,
  buildCopyPack,
  countByStatus,
  buildStudyCopy,
  buildHelperPost,
  fetchSeedGroundings,
  extractFocusWord,
  captionHasBannedCopy,
  BANNED_MARKETING_RE,
};
