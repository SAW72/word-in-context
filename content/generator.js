const { CONTENT_BRAND, publicMediaUrl } = require('./brand');
const {
  loadQueue,
  listPosts,
  upsertPosts,
  removePostsByIds,
  nextPillar,
  nextImage,
  newId,
} = require('./queue');

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
  return (brand.website || brand.appUrl || '').replace(/\/$/, '');
}

function ensureWebsiteInCaption(caption, website) {
  const url = (website || '').replace(/\/$/, '').trim();
  if (!url) return (caption || '').trim();
  const host = url.replace(/^https?:\/\//i, '').toLowerCase();
  const body = (caption || '').trim();
  const lower = body.toLowerCase();
  if (lower.includes(host) || lower.includes(url.toLowerCase())) {
    return body;
  }
  return `${body}\n\n${url}`;
}

function demoCopy(brand, pillarLabel, angle) {
  const cta = brand.ctaLines[Math.floor(Math.random() * brand.ctaLines.length)];
  const link = brandLink(brand);
  const caption = ensureWebsiteInCaption(
    [
      `Q: ${pillarLabel}?`,
      '',
      `A: ${angle}`,
      '',
      '(Study aid — read the passage yourself in context.)',
      '',
      brand.tagline,
      '',
      cta,
    ].join('\n'),
    link
  );
  return {
    caption,
    captionIg: caption.slice(0, 2100),
    hashtags: brand.hashtags.slice(0, 6),
    cta,
    question: pillarLabel,
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

async function generateWeekCopyBatch(brand, slots) {
  const apiKey = (process.env.XAI_API_KEY || '').trim();
  if (!apiKey || !slots.length) {
    return slots.map((s) => demoCopy(brand, s.pillar.label, s.pillar.angle));
  }

  const baseUrl = (process.env.XAI_BASE_URL || 'https://api.x.ai/v1').replace(
    /\/$/,
    ''
  );
  const model = process.env.XAI_MODEL || 'grok-4.3';

  const link = brandLink(brand);
  const system = `You write short social posts for ${brand.productName}, a voice-first Bible study app.
Voice: ${brand.voice}

FORMAT (required for every post):
1) First line: Q: <honest study question people actually ask>
2) Then A: <2–5 short sentences>. Prefer real references (e.g. John 1:1–14) when you cite.
3) One soft line: study aid / read the passage yourself.
4) End with CTA + the full website URL on its own line: ${link}

Rules:
- REQUIRED: every caption AND captionIg MUST include ${link}
- Do NOT invent exact Greek/Hebrew spellings if unsure; paraphrase carefully.
- No denomi-bait, no politics, no rage content.
- No hashtags in the caption body (we append them).
- Facebook: 70–160 words. Instagram can be slightly tighter.
- Return ONLY valid JSON:
{"posts":[{"question":"...","caption":"...","captionIg":"...","hashtags":["#TheWordInContext"],"cta":"..."}]}
posts length MUST equal ${slots.length} in order.`;

  const user = `Brand: ${brand.name}
Tagline: ${brand.tagline}
Website (REQUIRED in every post): ${link}
App: ${brand.appUrl}
Hashtag pool: ${brand.hashtags.join(', ')}
CTA pool: ${brand.ctaLines.join(' | ')}

Write ${slots.length} Q&A posts:
${slots
  .map(
    (s, i) =>
      `${i + 1}. date=${s.targetDate} theme=${s.pillar.label} angle=${s.pillar.angle}`
  )
  .join('\n')}`;

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
          temperature: 0.75,
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
      if (p?.caption?.trim()) return p;
      return demoCopy(brand, s.pillar.label, s.pillar.angle);
    });
  } catch (err) {
    console.warn('[content] grok failed, demo copy', err.message);
    return slots.map((s) => demoCopy(brand, s.pillar.label, s.pillar.angle));
  }
}

async function generatePosts({ days = 7, mode = 'replace' } = {}) {
  const brand = CONTENT_BRAND;
  const nDays = Math.max(1, Math.min(days, 14));
  const start = new Date();
  const warnings = [];
  const existing = loadQueue().posts;
  const byDate = new Map(existing.map((p) => [p.targetDate, p]));
  const removeIds = new Set();
  const slots = [];

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
    slots.push({
      day,
      targetDate,
      pillar: nextPillar(brand),
      imageKey: nextImage(brand),
    });
  }

  if (removeIds.size) removePostsByIds([...removeIds]);

  if (!slots.length) {
    const pending = existing.filter((p) =>
      ['queued', 'failed', 'draft'].includes(p.status)
    ).length;
    return {
      posts: [],
      warnings: [
        ...warnings,
        pending
          ? `${pending} post(s) ready — use Publish (not Generate).`
          : 'Nothing to generate.',
      ],
    };
  }

  const copies = await generateWeekCopyBatch(brand, slots);
  const now = new Date().toISOString();
  const link = brandLink(brand);
  const created = slots.map((slot, i) => {
    const copy =
      copies[i] || demoCopy(brand, slot.pillar.label, slot.pillar.angle);
    const hashtags = copy.hashtags?.length
      ? copy.hashtags
      : brand.hashtags.slice(0, 6);
    const cta = copy.cta || brand.ctaLines[0];
    const rawCap = (copy.caption || '').trim();
    const rawIg = (copy.captionIg || copy.caption || '').trim() || rawCap;
    return {
      id: newId(),
      brandId: brand.id,
      pillarId: slot.pillar.id,
      status: 'queued',
      targetDate: slot.targetDate,
      scheduledAt: scheduledAtForDay(
        slot.day,
        brand.preferredHour,
        brand.timezone
      ),
      networks: [...brand.networks],
      caption: ensureWebsiteInCaption(rawCap, link),
      captionIg: ensureWebsiteInCaption(rawIg, link),
      question: copy.question || slot.pillar.label,
      hashtags,
      imageKey: slot.imageKey,
      imageUrl: publicMediaUrl(slot.imageKey),
      cta,
      createdAt: now,
      updatedAt: now,
    };
  });

  upsertPosts(created);
  if (!(process.env.XAI_API_KEY || '').trim()) {
    warnings.push('XAI_API_KEY missing — used template Q&A captions.');
  }
  return { posts: created, warnings };
}

function buildCopyPack(posts) {
  return posts
    .map((p, i) =>
      [
        `=== Post ${i + 1} · ${p.targetDate} · ${p.pillarId} ===`,
        `When: ${p.scheduledAt}`,
        `Q: ${p.question || ''}`,
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
        `CTA: ${p.cta}`,
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
};
