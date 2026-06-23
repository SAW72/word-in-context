const path = require('path');
// Local dev only — production (Render) uses dashboard env vars; never load a .env file there.
if (process.env.NODE_ENV !== 'production') {
  require('dotenv').config({ path: path.join(__dirname, '.env') });
}
const express = require('express');
const OpenAI = require('openai');
const stripe = process.env.STRIPE_SECRET_KEY
  ? require('stripe')(process.env.STRIPE_SECRET_KEY)
  : null;
const Database = require('better-sqlite3');
const jwt = require('jsonwebtoken');
const { Resend } = require('resend');
const bcrypt = require('bcryptjs');
const fs = require('fs');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 8787;

// Raw body for payment webhooks MUST be the very first middleware (before any express.json or body parsers)
// so that req.body is the raw Buffer/string for signature verification.
app.use('/api/stripe-webhook', express.raw({ type: 'application/json' }));
app.use('/api/whop-webhook', express.raw({ type: 'application/json' }));

// === SQLite DB for users (with Render persistent disk support) ===
// IMPORTANT: On Render, when adding the disk in the dashboard:
//   - Disk name: data          (this is the "variable data" you saw)
//   - Mount path: /data        <--- type exactly this (full path, not just "data", not root "/")
// Only files under /data survive deploys. Code uses /data/users.db so admin users don't get deleted on redeploy.
// Locally: normal project folder.
// We now check fs.existsSync('/data') FIRST — this is the most reliable signal that the disk you attached is actually mounted.
const onRender = fs.existsSync('/data') || !!process.env.RENDER || !!process.env.RENDER_EXTERNAL_URL;
let dbPath = onRender ? '/data/users.db' : path.join(__dirname, 'users.db');

console.log(`[DB] onRender=${onRender} (fs sees /data? ${fs.existsSync('/data')}), using path: ${dbPath}`);

const db = new Database(dbPath);
db.pragma('journal_mode = WAL');

// Schema (CREATE IF NOT EXISTS) must run before any SELECT on users table.
// This is why a fresh disk volume was causing "no such table" and fallback.
try {
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      email TEXT UNIQUE NOT NULL,
      stripe_customer_id TEXT,
      stripe_subscription_id TEXT,
      status TEXT DEFAULT 'trialing',  -- trialing, active, past_due, canceled, free, disabled
      trial_end TEXT,
      access_granted INTEGER DEFAULT 1,  -- 1 = can use, 0 = cut off
      manual_free INTEGER DEFAULT 0,     -- admin can grant free forever
      created_at TEXT DEFAULT (datetime('now'))
    );
  `);
  try { db.exec(`ALTER TABLE users ADD COLUMN password_hash TEXT`); } catch(e){}
  try { db.exec(`ALTER TABLE users ADD COLUMN group_name TEXT`); } catch(e){}
  try { db.exec(`ALTER TABLE users ADD COLUMN whop_membership_id TEXT`); } catch(e){}
  try { db.exec(`ALTER TABLE users ADD COLUMN whop_member_id TEXT`); } catch(e){}
  db.exec(`
    CREATE TABLE IF NOT EXISTS magic_tokens (
      token TEXT PRIMARY KEY,
      email TEXT NOT NULL,
      expires_at TEXT NOT NULL
    );
  `);
  db.exec(`
    CREATE TABLE IF NOT EXISTS shares (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL,
      payload TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now'))
    );
  `);
  const userCount = db.prepare('SELECT COUNT(*) as c FROM users').get().c;
  console.log(`[DB] Schema ready at ${dbPath}. Current users: ${userCount}`);
} catch (err) {
  console.error('DB schema error (non-fatal):', err.message);
}

// === Email (Resend) ===
const resend = process.env.RESEND_API_KEY ? new Resend(process.env.RESEND_API_KEY) : null;

const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret-change-me';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'change-this';

// Configurable for easy tuning without code changes (set in Render env)
const TRIAL_DAYS = parseInt(process.env.TRIAL_DAYS || '7', 10);
const DEMO_LIMIT = parseInt(process.env.DEMO_LIMIT || '10', 10);
const TESTER_TRIAL_DAYS = parseInt(process.env.TESTER_TRIAL_DAYS || '14', 10);
const APP_BASE_URL = (process.env.RENDER_EXTERNAL_URL || 'http://localhost:8787').replace(/\/$/, '');
// Public links in shares/OG must use the canonical site (not *.onrender.com).
const SHARE_SITE_URL = (process.env.SHARE_SITE_URL || 'https://www.thewordincontext.org').replace(/\/$/, '');
// Bump when share-og.png changes so Facebook fetches a fresh thumbnail (it caches by image URL).
const SHARE_OG_VERSION = process.env.SHARE_OG_VERSION || 'cross5';

function shareOgImageUrl() {
  return `${SHARE_SITE_URL}/icons/share-og.png?v=${SHARE_OG_VERSION}`;
}

function newShareId() {
  return crypto.randomBytes(6).toString('base64url');
}

function escapeHtml(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function ogMetaText(str) {
  // Meta tag attributes must be one line or Facebook drops the description.
  return escapeHtml(String(str || '').replace(/\s+/g, ' ').trim());
}

function buildShareDisplay(payload) {
  if (!payload || typeof payload !== 'object') return { title: 'The Word in Context', body: '', ogDescription: '' };
  if (payload.type === 'verse') {
    const ref = String(payload.reference || 'Scripture').trim();
    const trans = String(payload.translation || '').trim();
    const text = String(payload.text || '').trim();
    const citation = text ? `"${text}" — ${ref}${trans ? ` (${trans})` : ''}` : `${ref}${trans ? ` (${trans})` : ''}`;
    return {
      title: `${ref} — The Word in Context`,
      body: citation,
      ogDescription: citation.slice(0, 300),
    };
  }
  if (payload.type === 'conversation') {
    const question = String(payload.question || '').trim();
    const reply = String(payload.reply || '').trim();
    let body = '';
    if (question) body += `Q: ${question}\n\n`;
    body += `AI: ${reply}`;
    const title = question ? `Q: ${question.slice(0, 80)}` : 'Study with AI';
    return {
      title: `${title} — The Word in Context`,
      body,
      ogDescription: body.replace(/\s+/g, ' ').trim().slice(0, 300),
    };
  }
  return { title: 'The Word in Context', body: '', ogDescription: '' };
}

function normalizeEmail(email) {
  return String(email || '').trim().toLowerCase();
}

async function hashPassword(password) {
  if (!password || String(password).length < 8) return null;
  return bcrypt.hash(String(password), 10);
}

const DEFAULT_WHOP_CHECKOUT_URL_MONTHLY = 'https://whop.com/checkout/plan_W9vAA0xyptzgt';
const DEFAULT_WHOP_CHECKOUT_URL_YEARLY = 'https://whop.com/checkout/plan_xjGkPczz1CWju';
const DEFAULT_WHOP_PLAN_IDS = [
  'plan_hWWAQiPvpAYKN',
  'plan_xjGkPczz1CWju',
  'plan_W9vAA0xyptzgt',
];

function whopCheckoutUrlForBilling(billing = 'monthly') {
  const cycle = String(billing || 'monthly').toLowerCase() === 'yearly' ? 'yearly' : 'monthly';
  if (cycle === 'yearly') {
    return (
      process.env.WHOP_CHECKOUT_URL_YEARLY
      || process.env.WHOP_CHECKOUT_URL
      || DEFAULT_WHOP_CHECKOUT_URL_YEARLY
    ).trim();
  }
  return (
    process.env.WHOP_CHECKOUT_URL_MONTHLY
    || process.env.WHOP_CHECKOUT_URL
    || DEFAULT_WHOP_CHECKOUT_URL_MONTHLY
  ).trim();
}

function whopCheckoutUrl() {
  return whopCheckoutUrlForBilling('monthly');
}

function whopPlanIds() {
  const raw = (process.env.WHOP_PLAN_IDS || '').trim();
  if (raw) {
    return raw.split(',').map((s) => s.trim()).filter(Boolean);
  }
  return DEFAULT_WHOP_PLAN_IDS.slice();
}

function whopConfigured() {
  return !!whopCheckoutUrl();
}

function whopWebhookConfigured() {
  return !!(whopConfigured() && process.env.WHOP_WEBHOOK_SECRET);
}

function stripeConfigured() {
  return !!(stripe && process.env.STRIPE_SECRET_KEY && process.env.STRIPE_PRICE_ID);
}

function paymentProvider() {
  if (whopConfigured()) return 'whop';
  if (stripeConfigured()) return 'stripe';
  return null;
}

function whopWebhookSigningKey(secret) {
  const s = String(secret || '').trim();
  if (s.startsWith('whsec_')) return Buffer.from(s.slice(6), 'base64');
  return Buffer.from(s, 'base64');
}

function verifyWhopWebhook(rawBody, headers) {
  const secret = process.env.WHOP_WEBHOOK_SECRET;
  if (!secret) throw new Error('WHOP_WEBHOOK_SECRET not configured');

  const id = headers['webhook-id'] || headers['Webhook-Id'];
  const timestamp = headers['webhook-timestamp'] || headers['Webhook-Timestamp'];
  const signatureHeader = headers['webhook-signature'] || headers['Webhook-Signature'];
  if (!id || !timestamp || !signatureHeader) {
    throw new Error('Missing Whop webhook headers');
  }

  const ts = parseInt(timestamp, 10);
  if (!Number.isFinite(ts) || Math.abs(Date.now() / 1000 - ts) > 300) {
    throw new Error('Whop webhook timestamp outside tolerance');
  }

  const bodyText = Buffer.isBuffer(rawBody) ? rawBody.toString('utf8') : String(rawBody || '');
  const signedContent = `${id}.${timestamp}.${bodyText}`;
  const key = whopWebhookSigningKey(secret);
  const expected = crypto.createHmac('sha256', key).update(signedContent).digest('base64');

  const signatures = String(signatureHeader).split(/\s+/);
  for (const sig of signatures) {
    const comma = sig.indexOf(',');
    if (comma === -1) continue;
    const version = sig.slice(0, comma);
    const value = sig.slice(comma + 1);
    if (version !== 'v1' || !value) continue;
    try {
      const a = Buffer.from(value);
      const b = Buffer.from(expected);
      if (a.length === b.length && crypto.timingSafeEqual(a, b)) {
        return JSON.parse(bodyText);
      }
    } catch (_) {}
  }
  throw new Error('Invalid Whop webhook signature');
}

function buildWhopCheckoutUrl(email, billing = 'monthly') {
  const base = whopCheckoutUrlForBilling(billing);
  const url = base.startsWith('http') ? new URL(base) : new URL(`https://whop.com/checkout/${base.replace(/^\//, '')}`);
  url.searchParams.set('email', email);
  url.searchParams.set('email.disabled', '1');
  return url.toString();
}

function whopPayloadEmail(payload) {
  return normalizeEmail(
    payload?.user?.email
    || payload?.member?.user?.email
    || payload?.member?.email
    || payload?.email
  );
}

function whopPayloadManageUrl(payload) {
  return payload?.manage_url || payload?.membership?.manage_url || 'https://whop.com/billing';
}

function formatWhopDate(iso) {
  if (!iso) return null;
  try {
    return new Date(iso).toLocaleDateString('en-US', {
      weekday: 'long',
      month: 'long',
      day: 'numeric',
      year: 'numeric',
    });
  } catch (_) {
    return null;
  }
}

function whopPayloadPlanId(payload) {
  return payload?.plan?.id || payload?.plan_id || null;
}

function whopMembershipIsAllowed(payload) {
  const allowed = whopPlanIds();
  if (!allowed.length) return true;
  const planId = whopPayloadPlanId(payload);
  return !planId || allowed.includes(planId);
}

function mapWhopStatusToUserStatus(whopStatus) {
  const s = String(whopStatus || '').toLowerCase();
  if (['trialing', 'active'].includes(s)) return s;
  if (['canceled', 'cancelled', 'expired', 'completed', 'past_due', 'unresolved'].includes(s)) return 'canceled';
  return 'active';
}

async function ensureStripeCustomer(user, email) {
  if (user.stripe_customer_id) return user.stripe_customer_id;
  const customer = await stripe.customers.create({ email });
  db.prepare('UPDATE users SET stripe_customer_id = ? WHERE id = ?').run(customer.id, user.id);
  return customer.id;
}

function issueUserJwt(user, expiresIn = '30d') {
  return jwt.sign({ email: user.email, id: user.id }, JWT_SECRET, { expiresIn });
}

function userHasAccess(user) {
  const now = new Date();
  const trialValid = !!(user.trial_end && now < new Date(user.trial_end));
  const effectivelyTrialing = (user.status === 'trialing') && trialValid;
  // past_due: keep access while Whop retries billing; membership.deactivated cuts access off
  const hasPaidOrFree = ['active', 'free', 'past_due'].includes(user.status) || !!user.manual_free;
  return !!user.access_granted && (effectivelyTrialing || hasPaidOrFree);
}

// Production note: When deploying (Render, Railway, etc.), set NODE_ENV=production
// and provide XAI_API_KEY + any future keys via the platform's environment variables.
// Free tiers may sleep the service — that's fine for early beta.

// === xAI Client (secure — key never leaves the server) ===
const XAI_MODEL = (process.env.XAI_MODEL || 'grok-4.3').trim();
function getXaiApiKey() {
  // Render dashboard secrets sometimes include trailing newline or stray quotes — trim them.
  return String(process.env.XAI_API_KEY || '').trim().replace(/^["']+|["']+$/g, '');
}
const xai = new OpenAI({
  apiKey: getXaiApiKey(),
  baseURL: 'https://api.x.ai/v1',
  timeout: 120_000,
  maxRetries: 3,
});

function xaiKeyLooksConfigured() {
  const key = getXaiApiKey();
  return key.startsWith('xai-') && key.length > 24 && !/your-key-here/i.test(key);
}

function formatXaiError(err) {
  const msg = String(err?.message || '');
  const status = err?.status;
  if (status === 401 || status === 403 || /invalid.*api.*key|incorrect api key/i.test(msg)) {
    return 'AI service authentication failed on the server. The XAI_API_KEY in Render may be missing, expired, or different from your working local key.';
  }
  if (/premature close|econnreset|etimedout|socket hang up|fetch failed/i.test(msg)) {
    return 'AI service connection dropped. Please try again in a few seconds. If this keeps happening, verify XAI_API_KEY in the Render dashboard matches your working local .env key.';
  }
  if (status === 429 || /rate limit/i.test(msg)) {
    return 'AI service rate limit reached. Please wait a moment and try again.';
  }
  return 'Unable to get a study response right now. Please try again.';
}

const XAI_MODEL_FALLBACKS = [...new Set([
  XAI_MODEL,
  'grok-3',
  'grok-2-latest',
].filter(Boolean))];

async function callXaiChatOnce(model, apiMessages) {
  const body = {
    model,
    messages: apiMessages,
    temperature: 0.55,
    max_tokens: 1600,
  };
  const url = 'https://api.x.ai/v1/chat/completions';
  let lastErr;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${getXaiApiKey()}`,
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(120_000),
      });
      const raw = await res.text();
      let data;
      try {
        data = JSON.parse(raw);
      } catch {
        const err = new Error(`xAI returned non-JSON (${res.status})`);
        err.status = res.status;
        throw err;
      }
      if (!res.ok) {
        const detail = data?.error?.message || data?.error || `HTTP ${res.status}`;
        const err = new Error(typeof detail === 'string' ? detail : JSON.stringify(detail));
        err.status = res.status;
        throw err;
      }
      return data.choices?.[0]?.message?.content || 'No response generated.';
    } catch (err) {
      lastErr = err;
      const retryable = /premature|econnreset|etimedout|timeout|502|503|504|fetch failed|non-json/i.test(String(err.message));
      if (!retryable || attempt === 2) break;
      await new Promise((r) => setTimeout(r, 700 * (attempt + 1)));
    }
  }
  try {
    const completion = await xai.chat.completions.create(body);
    return completion.choices?.[0]?.message?.content || 'No response generated.';
  } catch (sdkErr) {
    throw lastErr || sdkErr;
  }
}

// Native fetch is more reliable on Render than the OpenAI SDK alone (avoids "Premature close").
async function callXaiChat(apiMessages) {
  let lastErr;
  for (const model of XAI_MODEL_FALLBACKS) {
    try {
      const reply = await callXaiChatOnce(model, apiMessages);
      if (model !== XAI_MODEL) {
        console.warn(`[xAI] primary model ${XAI_MODEL} failed; succeeded with fallback ${model}`);
      }
      return reply;
    } catch (err) {
      lastErr = err;
      console.warn(`[xAI] model ${model} failed:`, err?.status || '', err?.message || err);
    }
  }
  throw lastErr || new Error('xAI request failed');
}

// Block adult, violent, and off-topic harmful requests before they reach the LLM.
function getBlockedContentReason(text) {
  if (!text || typeof text !== 'string') return null;
  const t = text.toLowerCase().replace(/\s+/g, ' ').trim();
  const adult = /\b(porn|pornograph|xxx|nudes?|naked|erotic|fetish|onlyfans|hentai|nsfw|sext(?:ing)?|stripper|prostitut|escort\s+service|adult\s+content|sex\s+toy)\b/.test(t);
  if (adult) {
    return 'This app is for Scripture study only. Adult or sexual content requests are not permitted.';
  }
  const harm = /\b(how\s+to\s+(kill|murder|harm|hurt|poison|stab|shoot)|make\s+a\s+bomb|build\s+a\s+bomb|suicide\s+method|self[- ]harm\s+method)\b/.test(t);
  if (harm) {
    return 'This app cannot assist with harming people. For crisis support, contact a pastor, counselor, or local emergency services.';
  }
  return null;
}

// Very lightweight in-memory demo throttle (protects the xAI key from scrapers/bots hitting /app?demo=1)
// No extra deps. For production you can later add express-rate-limit + helmet.
const demoUsage = new Map(); // ip -> array of timestamps (last hour)
function checkDemoThrottle(ip) {
  const now = Date.now();
  const hour = 60 * 60 * 1000;
  if (!ip) return true;
  let times = demoUsage.get(ip) || [];
  times = times.filter(t => now - t < hour);
  if (times.length >= 50) { // max 50 demo chats per IP per hour (very generous for real users, stops bots)
    demoUsage.set(ip, times);
    return false;
  }
  times.push(now);
  demoUsage.set(ip, times);
  return true;
}

// === Strong System Prompt for "The Word in Context" ===
const SYSTEM_PROMPT = `You are an expert, reverent guide for studying the Hebrew, Aramaic, and Greek Scriptures in their original languages and literary contexts. You are the AI assistant inside the "Word in Context" Bible app.

CORE COMMITMENTS — never violate these:

Translation Policy
Use only the Berean Standard Bible (BSB) by default. Quote exclusively from English translations available on bible.helloao.org: Berean Standard Bible (BSB), American Standard Version (ASV), Young's Literal Translation (YLT), or World English Bible (WEB). Never quote NASB, ESV, NKJV, LSB, NIV, NLT, or The Message. When [ACCURATE BIBLE TEXT] grounding is provided below for a specific reference, quote that exact wording verbatim and cite the translation named in that block. For any other passage you discuss, quote from the allowed translations above. When explaining any word or phrase, always begin with the literal English rendering before showing the underlying Hebrew, Aramaic, or Greek.

Conversation Scope
Each new user question sets the topic for your reply. You may discuss any Scripture, book, chapter, verse, theme, or topic the user asks about — across the entire Bible, in any allowed English translation and in Greek, Hebrew, or Aramaic where relevant. You are never limited to only the verses in grounding blocks below. If the user previously discussed one passage and now asks a different question (for example, moving from Revelation 21:8 to "healing verses in the Bible"), answer the new question fully and bring in every relevant passage. Grounding blocks are supplementary anchors for specific references, not a cage around the conversation.

Topical Scripture Requests
When the user asks for scriptures, verses, or passages about a subject or theme (healing, faith, fear, marriage, salvation, etc.), actively identify and present every relevant biblical passage across the Old and New Testaments. Quote or cite each reference, state what The Word explicitly says about the subject, and use allowed translations. Never refuse a topical request because no grounding block was fetched for those verses, and never limit yourself to an earlier verse from the same conversation. The user is asking you to find scriptures — bring them.

Strict Context Rule
Every answer must be grounded in what The Word explicitly says. Interpret Scripture only with Scripture. Never use information, history, or context from outside Scripture itself. "According to Scripture" means all claims must be supported by biblical passages — it does NOT mean you may only discuss verses already shown in grounding blocks below.

No Inferences or Weighing of Passages
Never compare the number of passages on a topic, never weigh one set of verses against another, and never suggest that frequency of mention implies importance or emphasis. When the user asks for multiple passages on a theme, you may survey and explain each passage on its own merits — but do not rank or count them.

Handling Traditions and Practices
When asked about any religious practice or tradition, first state exactly what The Word explicitly commands or institutes. If Scripture does not command or institute that practice, you may state: "This practice is not commanded in The Word."

Original Languages
When the user asks for word study, Greek/Hebrew/Aramaic meanings, transliteration, lexical range, or "the Greek/Hebrew of" a term, this is core Scripture study — always answer fully. Provide the original-language form, transliteration, literal gloss as used in the passage, and how The Word employs the term there (and in other Scripture uses when helpful). If they are following up on a passage already in this conversation (e.g. Hebrews 4:12) without repeating the reference, anchor your analysis to that passage. Original-language word study is never "outside Scripture" and must not be refused. For general answers without a word-study request, begin with literal English before introducing Greek or Hebrew. Never speak or pronounce Hebrew or Greek words aloud unless requested.

Citations
Whenever you reference a verse, immediately follow it with the translation name, for example: "according to the Berean Standard Bible." Mention the original language source only once per response, such as "in the Hebrew manuscript" or "in the Greek manuscript."

Wording Rule (strict — apply in every response)
When attributing meaning to Scripture, ALWAYS use "The Word states...", "The Word indicates...", or "The Word says...". NEVER use "the text states", "the text indicates", "this text states", "the biblical text states", or "the passage states" when you mean Scripture. The only acceptable use of "text" is for original-language manuscripts (e.g. "the Hebrew manuscript", "the Greek wording") — never as a substitute for "The Word" when citing what Scripture teaches.

Tone and Boundaries
Always present the Scriptures exactly as they are written, including both strong warnings and gracious promises when they appear in the text. Never soften, remove, or avoid difficult verses. Maintain a humble and respectful tone, but never add emotional encouragement, devotional thoughts, or application that goes beyond what the text itself actually says. You may also say "a more literal rendering would be..."

Content Safety (strict)
- This app is for Scripture study only. Refuse any request for pornography, sexual content, erotica, explicit material, or adult entertainment — even if framed as "Bible study."
- Refuse requests for instructions to harm, kill, abuse, or endanger people. Do not provide weapons, violence, or self-harm how-to content.
- Refuse requests clearly unrelated to studying the Hebrew, Aramaic, and Greek Scriptures and their literal English renderings.
- When refusing, stay brief, gracious, and redirect the user back to Scripture study.

APP IDENTITY & DISCLAIMER
You must always remain consistent with this disclaimer:

Important Disclaimer
The Word in Context is an AI study tool designed to help you engage with the Scriptures in their original Hebrew, Aramaic, and Greek languages using literal translations.
• All explanations and insights are generated by artificial intelligence.
• The AI is not a pastor, priest, or spiritual authority.
• Every response should be tested against the Bible itself. "Test everything; hold fast what is good" (1 Thessalonians 5:21).
• This app is not intended to replace personal prayer, careful personal study, or the guidance of mature believers and church leaders.
• We are not affiliated with any denomination or church tradition.

Your use of this app is at your own discretion. We strive for accuracy and reverence, but final responsibility for understanding and applying Scripture rests with you.

APP INSTRUCTOR ROLE
You are also the official, friendly instructor inside the "Word in Context" Bible app. When the user asks anything about how the app works, answer naturally and clearly while staying reverent. You know:

How to change the default English translation
How to pick and test voices
How the wake-word / hands-free mode works
What the Sources panel shows
How to save chats, start new ones, clear history, etc.

Answer these questions helpfully and precisely.

Speak all responses aloud naturally as if reading to the user. Do not use commands or formatting in your spoken replies.`;

// Keep Grok's phrasing consistent with the app's "The Word" voice (models often slip into "the text states").
function normalizeWordPhrasing(text) {
  if (!text || typeof text !== 'string') return text;
  return text
    .replace(/\bthe biblical text (states|indicates|says|teaches|shows|declares)\b/gi, 'The Word $1')
    .replace(/\bthis text (states|indicates|says|teaches|shows|declares)\b/gi, 'The Word $1')
    .replace(/\bthe text (states|indicates|says|teaches|shows|declares)\b/gi, 'The Word $1')
    .replace(/\bthe passage (states|indicates|says|teaches|shows|declares)\b/gi, 'The Word $1')
    .replace(/\bscripture (states|indicates)\b/gi, 'The Word $1');
}

// === Bible verse fetcher using the Free Use Bible API ===
// Supports English literals (BSB etc.) + original languages:
//   Greek NT: grc_sbl (SBL Greek New Testament), grc_byz, grc_mtk, grc_gtr (TR), etc.
//   Hebrew OT: hbo_wlc / heb_wlc (Westminster Leningrad Codex - standard Masoretic Text)
// Correct endpoints: https://bible.helloao.org/api/{TRANSLATION}/{BOOK}/{CHAPTER}.json
// Pass the exact id from /api/available_translations.json (e.g. 'BSB', 'grc_sbl', 'hbo_wlc')
async function fetchBiblePassage(reference, translation = 'BSB') {
  try {
    const cleaned = reference.trim();
    const match = cleaned.match(/^(\d?\s*[A-Za-z]+)\s+(\d+)(?::(\d+)(?:-(\d+))?)?$/i);
    if (!match) return null;

    let book = match[1].trim();
    const chapter = match[2];
    const verseStart = parseInt(match[3] || '1', 10);
    const verseEnd = parseInt(match[4] || match[3] || '1', 10);

    const bookMap = {
      'genesis': 'GEN', 'gen': 'GEN',
      'exodus': 'EXO', 'exo': 'EXO', 'ex': 'EXO',
      'leviticus': 'LEV', 'lev': 'LEV',
      'numbers': 'NUM', 'num': 'NUM',
      'deuteronomy': 'DEU', 'deut': 'DEU',
      'joshua': 'JOS', 'josh': 'JOS',
      'judges': 'JDG', 'judg': 'JDG',
      'ruth': 'RUT',
      '1 samuel': '1SA', '1sam': '1SA',
      '2 samuel': '2SA', '2sam': '2SA',
      '1 kings': '1KI', '1kings': '1KI',
      '2 kings': '2KI', '2kings': '2KI',
      '1 chronicles': '1CH', '1chr': '1CH',
      '2 chronicles': '2CH', '2chr': '2CH',
      'ezra': 'EZR',
      'nehemiah': 'NEH', 'neh': 'NEH',
      'esther': 'EST',
      'job': 'JOB',
      'psalm': 'PSA', 'psalms': 'PSA', 'ps': 'PSA',
      'proverbs': 'PRO', 'prov': 'PRO',
      'ecclesiastes': 'ECC', 'eccl': 'ECC',
      'song of solomon': 'SNG', 'song': 'SNG',
      'isaiah': 'ISA', 'isa': 'ISA',
      'jeremiah': 'JER', 'jer': 'JER',
      'lamentations': 'LAM', 'lam': 'LAM',
      'ezekiel': 'EZE', 'ezek': 'EZE',
      'daniel': 'DAN', 'dan': 'DAN',
      'hosea': 'HOS',
      'joel': 'JOL',
      'amos': 'AMO',
      'obadiah': 'OBA', 'obad': 'OBA',
      'jonah': 'JON',
      'micah': 'MIC',
      'nahum': 'NAM',
      'habakkuk': 'HAB', 'hab': 'HAB',
      'zephaniah': 'ZEP', 'zeph': 'ZEP',
      'haggai': 'HAG',
      'zechariah': 'ZEC', 'zech': 'ZEC',
      'malachi': 'MAL', 'mal': 'MAL',
      'matthew': 'MAT', 'matt': 'MAT', 'mt': 'MAT',
      'mark': 'MRK', 'mk': 'MRK',
      'luke': 'LUK', 'lk': 'LUK',
      'john': 'JHN', 'jn': 'JHN',
      'acts': 'ACT',
      'romans': 'ROM', 'rom': 'ROM',
      '1 corinthians': '1CO', '1cor': '1CO',
      '2 corinthians': '2CO', '2cor': '2CO',
      'galatians': 'GAL', 'gal': 'GAL',
      'ephesians': 'EPH', 'eph': 'EPH',
      'philippians': 'PHP', 'phil': 'PHP',
      'colossians': 'COL', 'col': 'COL',
      '1 thessalonians': '1TH', '1thess': '1TH',
      '2 thessalonians': '2TH', '2thess': '2TH',
      '1 timothy': '1TI', '1tim': '1TI',
      '2 timothy': '2TI', '2tim': '2TI',
      'titus': 'TIT',
      'philemon': 'PHM', 'phlm': 'PHM',
      'hebrews': 'HEB', 'heb': 'HEB',
      'james': 'JAS', 'jas': 'JAS',
      '1 peter': '1PE', '1pet': '1PE',
      '2 peter': '2PE', '2pet': '2PE',
      '1 john': '1JN', '1jn': '1JN',
      '2 john': '2JN', '2jn': '2JN',
      '3 john': '3JN', '3jn': '3JN',
      'jude': 'JUD',
      'revelation': 'REV', 'rev': 'REV'
    };

    const bookKey = book.toLowerCase();
    const bookCode = bookMap[bookKey] || book.toUpperCase().slice(0, 3);
    // Use the translation id exactly as provided (e.g. 'BSB' for English, 'grc_sbl' for SBL Greek NT, 'hbo_wlc' for Westminster Leningrad Codex Hebrew).
    // The API uses specific casing/underscores for original language resources.
    const trans = translation;

    // Correct endpoint: https://bible.helloao.org/api/BSB/JHN/3.json
    const url = `https://bible.helloao.org/api/${trans}/${bookCode}/${chapter}.json`;
    console.log(`[Bible API] Trying: ${url}`);

    const res = await fetch(url, { headers: { 'Accept': 'application/json' } });

    // Guard against HTML error pages / wrong URLs (the source of the "<!doctype" errors)
    const contentType = res.headers.get('content-type') || '';
    if (!res.ok || !contentType.includes('json')) {
      console.error(`Bible API non-JSON response for: ${url} (status: ${res.status})`);
      return null;
    }

    const data = await res.json();

    // The real structure: data.chapter.content is an array of objects
    const content = data?.chapter?.content;
    if (!Array.isArray(content)) return null;

    // Extract verses in the requested range
    const verses = [];
    for (const item of content) {
      if (item.type === 'verse' && typeof item.number === 'number') {
        if (item.number >= verseStart && item.number <= verseEnd) {
          // Join the text pieces inside the verse content
          const verseText = (item.content || [])
            .map(part => (typeof part === 'string' ? part : part?.text || ''))
            .join(' ')
            .trim();
          if (verseText) {
            verses.push(`${item.number}. ${verseText}`);
          }
        }
      }
    }

    if (verses.length === 0) return null;

    return {
      reference: `${book} ${chapter}:${verseStart}${verseEnd !== verseStart ? '-' + verseEnd : ''}`,
      translation: trans,
      text: verses.join(' ')
    };
  } catch (e) {
    // Keep errors quiet in production so they don't pollute the chat
    console.error('Bible API fetch error (non-fatal):', e.message);
    // Extra debug: if we ever hit this with the JSON error again, log more context
    if (e.message && e.message.includes('Unexpected token')) {
      console.error('  ^ This usually means we hit an HTML page instead of JSON. Check the [Bible API] Trying line above.');
    }
    return null;
  }
}

app.use(express.json({ limit: '50mb' }));

// === STT: permanently disabled (pure browser SpeechRecognition fallback) ===
// HF (wake "John"), barge-in, live interim, and final transcript all use webkitSpeechRecognition.
app.post('/api/stt', express.json({ limit: '100mb' }), (req, res) => {
  return res.json({ text: '', fallback: true, disabled: true });
});

// 413 catcher so huge audio payloads don't spam logs; client falls back to browser SR.
app.use((err, req, res, next) => {
  if (err && (err.status === 413 || err.type === 'entity.too.large' || (err.message || '').toLowerCase().includes('too large'))) {
    if (req.path === '/api/stt') {
      return res.status(413).json({ text: '', fallback: true, error: 'payload too large' });
    }
    return res.status(413).json({ error: 'payload too large' });
  }
  next(err);
});

// Trust proxy so req.ip is correct behind Render / CDNs (for the demo throttle)
app.set('trust proxy', 1);

// Auth middleware
function requireAuth(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Authentication required' });
  }
  const token = authHeader.split(' ')[1];
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    req.user = payload; // { email, id? }

    // Check DB status
    const user = db.prepare('SELECT * FROM users WHERE email = ?').get(payload.email);
    if (!user) {
      return res.status(401).json({ error: 'User not found' });
    }
    if (!user.access_granted) {
      return res.status(403).json({ error: 'Account access has been revoked. Contact support.' });
    }
    const now = new Date();
    const isTrialing = user.status === 'trialing' && user.trial_end && now < new Date(user.trial_end);
    const isActive = user.status === 'active' || user.status === 'free' || user.manual_free;
    if (!isTrialing && !isActive && user.status !== 'trialing') {
      return res.status(403).json({ error: 'Subscription required or trial expired.' });
    }
    req.userRecord = user;
    next();
  } catch (e) {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
}

// Production security note for beta/public launch:
// npm install express-rate-limit helmet
// Then uncomment:
// const rateLimit = require('express-rate-limit');
// const helmet = require('helmet');
// app.use(helmet());
// const limiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 100 });
// app.use(limiter);

// Dev-friendly: prevent browser caching of the frontend so code changes (SR fixes, wake word, etc.)
// are picked up without manual hard-reloads or cache clearing. Safe for localhost dev.
// Also set a permissive CSP during dev so that:
// - Our inline <style> and (previously) event handlers work without 'unsafe-inline' complaints
// - Blob URLs for TTS audio playback are allowed
// - Fetches to xAI, ElevenLabs, bible.helloao.org etc. are allowed
// - Any 'eval' usage from browser APIs or (more commonly) injected extension scripts doesn't
//   produce the "Content Security Policy of your site blocks the use of 'eval'" noise.
// In a real production SaaS deployment you would tighten this significantly (nonces, hashes,
// specific hosts, no unsafe-eval, etc.).
app.use((req, res, next) => {
  // Service worker must revalidate on each visit so updates apply; shell assets are cached by SW.
  if (req.path === '/sw.js') {
    res.set('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.set('Service-Worker-Allowed', '/');
  } else if (req.path === '/manifest.webmanifest' || req.path.startsWith('/icons/')) {
    res.set('Cache-Control', 'public, max-age=86400');
  } else {
    res.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    res.set('Pragma', 'no-cache');
    res.set('Expires', '0');
  }

  // Permissive for localhost dev only. Prevents our own code + common extension noise from
  // triggering CSP violations in the console.
  res.set('Content-Security-Policy',
    "default-src 'self' 'unsafe-inline' 'unsafe-eval' blob: data: https: http: ws: wss:; " +
    "connect-src 'self' https: http: ws: wss:; " +
    "media-src 'self' blob: data: https:; " +
    "img-src 'self' data: https:; " +
    "script-src 'self' 'unsafe-inline' 'unsafe-eval' https:; " +
    "style-src 'self' 'unsafe-inline' https:;"
  );

  next();
});

let landingHtmlWithOg = null;
function landingHtmlWithOgTags() {
  if (landingHtmlWithOg) return landingHtmlWithOg;
  const raw = fs.readFileSync(path.join(__dirname, 'public', 'landing.html'), 'utf8');
  const ogImage = shareOgImageUrl();
  const ogTags = `
  <link rel="canonical" href="${SHARE_SITE_URL}/">
  <meta property="og:title" content="The Word in Context">
  <meta property="og:description" content="Voice-first offline Bible study with AI — understand Scripture in its original context.">
  <meta property="og:url" content="${SHARE_SITE_URL}/">
  <meta property="og:type" content="website">
  <meta property="og:site_name" content="The Word in Context">
  <meta property="og:image" content="${escapeHtml(ogImage)}">
  <meta property="og:image:secure_url" content="${escapeHtml(ogImage)}">
  <meta property="og:image:type" content="image/png">
  <meta property="og:image:width" content="1200">
  <meta property="og:image:height" content="630">
  <meta property="og:image:alt" content="The Word in Context — voice-first Bible study">
  <meta name="twitter:card" content="summary_large_image">
  <meta name="twitter:title" content="The Word in Context">
  <meta name="twitter:description" content="Voice-first offline Bible study with AI">
  <meta name="twitter:image" content="${escapeHtml(ogImage)}">`;
  landingHtmlWithOg = raw.replace('</head>', `${ogTags}\n</head>`);
  return landingHtmlWithOg;
}

app.get('/copyright', (req, res) => res.redirect(301, '/attributions.html'));

// Serve beautiful public marketing landing page at root
// For closed beta: you can add simple password or email whitelist here before full auth.
app.get('/', (req, res) => {
  res.type('html').send(landingHtmlWithOgTags());
});

// Serve the full chat app at /app (so landing can promote signups)
app.get('/app', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Admin control panel - explicit route so /admin serves the panel (password protected inside via ADMIN_PASSWORD env)
// Must be before static middleware.
app.get('/admin', (req, res) => {
  console.log('[admin] serving admin panel page');
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

// Public share pages — Facebook/Twitter crawlers read OG tags; humans see the verse or Q&A.
app.get('/share/:id', (req, res) => {
  const id = String(req.params.id || '').trim();
  if (!id || id.length > 32) return res.status(404).send('Share not found');
  const row = db.prepare('SELECT type, payload FROM shares WHERE id = ?').get(id);
  if (!row) return res.status(404).send('Share not found');

  let payload;
  try {
    payload = JSON.parse(row.payload);
  } catch (e) {
    return res.status(500).send('Invalid share data');
  }

  const display = buildShareDisplay(payload);
  const pageUrl = `${SHARE_SITE_URL}/share/${id}`;
  const ogImage = shareOgImageUrl();
  const safeTitle = ogMetaText(display.title);
  const safeBody = escapeHtml(display.body).replace(/\n/g, '<br>');
  const safeOg = ogMetaText(display.ogDescription);
  const ua = String(req.headers['user-agent'] || '');
  const isCrawler = /facebookexternalhit|Facebot|Twitterbot|LinkedInBot|WhatsApp|Slackbot|Discordbot|TelegramBot/i.test(ua);

  res.type('html').send(`<!DOCTYPE html>
<html lang="en" prefix="og: https://ogp.me/ns#">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${safeTitle}</title>
  <link rel="canonical" href="${escapeHtml(pageUrl)}">
  <meta name="description" content="${safeOg}">
  <meta property="og:title" content="${safeTitle}">
  <meta property="og:description" content="${safeOg}">
  <meta property="og:url" content="${escapeHtml(pageUrl)}">
  <meta property="og:type" content="article">
  <meta property="og:site_name" content="The Word in Context">
  <meta property="og:image" content="${escapeHtml(ogImage)}">
  <meta property="og:image:secure_url" content="${escapeHtml(ogImage)}">
  <meta property="og:image:type" content="image/png">
  <meta property="og:image:width" content="1200">
  <meta property="og:image:height" content="630">
  <meta property="og:image:alt" content="The Word in Context — voice-first Bible study">
  <meta name="twitter:card" content="summary_large_image">
  <meta name="twitter:title" content="${safeTitle}">
  <meta name="twitter:description" content="${safeOg}">
  <meta name="twitter:image" content="${escapeHtml(ogImage)}">
  <style>
    body { font-family: Georgia, serif; background: #f8f5f2; color: #2c3e50; margin: 0; padding: 32px 20px; line-height: 1.6; }
    .card { max-width: 640px; margin: 0 auto; background: #fff; border-radius: 12px; padding: 28px; box-shadow: 0 2px 12px rgba(0,0,0,0.08); }
    h1 { font-size: 22px; margin: 0 0 16px; color: #2c3e50; }
    .body { font-size: 17px; white-space: pre-wrap; }
    .cta { margin-top: 24px; }
    a { color: #8b5e3c; font-weight: 600; }
  </style>
</head>
<body>
  <div class="card">
    <h1>${safeTitle}</h1>
    <div class="body">${safeBody}</div>
    <p class="cta"><a href="/app">Open The Word in Context →</a></p>
  </div>
  ${isCrawler ? '' : `<script>
    setTimeout(function () {
      if (!document.hidden) window.location.replace('/app');
    }, 4000);
  </script>`}
</body>
</html>`);
});

// Static assets (for any future images/css if split)
app.use(express.static(path.join(__dirname, 'public')));

app.get('/favicon.ico', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'icons', 'icon-192.png'));
});

// === Simple beta tester signup (stores emails for launch) ===
// For production: replace with real email service (Mailchimp, ConvertKit, or Supabase)
const betasFile = path.join(__dirname, 'betas.json');

app.post('/api/beta-signup', express.json({ limit: '10kb' }), (req, res) => {
  try {
    const { name, email, church } = req.body || {};
    if (!email || !email.includes('@')) {
      return res.status(400).json({ error: 'Valid email required' });
    }

    let betas = [];
    if (fs.existsSync(betasFile)) {
      try { betas = JSON.parse(fs.readFileSync(betasFile, 'utf8') || '[]'); } catch {}
    }

    // Dedup
    if (!betas.find(b => b.email.toLowerCase() === email.toLowerCase())) {
      betas.push({
        name: name || 'Anonymous',
        email: email.toLowerCase(),
        church: church || '',
        signedUp: new Date().toISOString(),
        source: 'landing'
      });
      fs.writeFileSync(betasFile, JSON.stringify(betas, null, 2));
      console.log(`[Beta Signup] ${email} (${name || ''})`);
    }

    res.json({ success: true, message: 'Thanks! Check your email for beta access.' });
  } catch (err) {
    console.error('Beta signup error:', err);
    res.status(500).json({ error: 'Could not save signup. Please try again.' });
  }
});

// === User login / account system with configurable trial (TRIAL_DAYS env) + Whop ===

async function sendWhopNotificationEmail(email, { subject, html }) {
  if (resend) {
    await resend.emails.send({
      from: 'The Word in Context <no-reply@thewordincontext.org>',
      to: email,
      subject,
      html,
    });
  } else {
    console.log(`[WHOP EMAIL to ${email}] ${subject}`);
  }
}

// Helper: send magic link email (or log in dev)
// options: { subject?, htmlPrefix?, isTester? }
async function sendMagicLink(email, token, options = {}) {
  const loginUrl = `${APP_BASE_URL}/login?token=${token}`;
  const isTester = !!options.isTester;
  const subject = options.subject || (isTester ? 'Your tester access to The Word in Context (14 days)' : 'Log in to The Word in Context');
  const prefix = options.htmlPrefix || (isTester 
    ? `<p>Welcome to <strong>The Word in Context</strong> as a tester!</p>
       <p>Your <strong>14-day tester access</strong> (no credit card required) has been activated. It ends automatically after 14 days unless extended.</p>`
    : `<p>Click to log in to <strong>The Word in Context</strong>:</p>`);
  const html = `
    ${prefix}
    <p><a href="${loginUrl}">Log in to your account</a></p>
    <p>This link expires in 15 minutes. If you didn't request this, ignore it.</p>
    <p><small>We will never sell your information. All chats are stored only in your browser. ${isTester ? 'This is tester access and will expire after the trial period.' : 'Payment info is handled securely by Whop. Your conversations never leave your device.'}</small></p>
  `;
  if (resend) {
    await resend.emails.send({
      from: 'The Word in Context <no-reply@thewordincontext.org>',
      to: email,
      subject,
      html
    });
  } else {
    console.log(`[MAGIC LINK for ${email}] ${loginUrl}`);
  }
}

async function upsertTrialCheckoutUser(email, password, effectiveTrialDays) {
  const passwordHash = await hashPassword(password);
  if (!passwordHash) throw Object.assign(new Error('Password must be at least 8 characters.'), { statusCode: 400 });

  let user = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
  if (!user) {
    db.prepare(`
      INSERT INTO users (email, status, trial_end, access_granted, password_hash)
      VALUES (?, 'trialing', datetime('now', '+${effectiveTrialDays} days'), 1, ?)
    `).run(email, passwordHash);
    user = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
  } else {
    if (passwordHash) {
      db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(passwordHash, user.id);
    }
    if (!user.trial_end) {
      db.prepare(`UPDATE users SET trial_end = datetime('now', '+${effectiveTrialDays} days') WHERE id = ?`).run(user.id);
    }
    if (!user.access_granted) {
      db.prepare('UPDATE users SET access_granted = 1 WHERE id = ?').run(user.id);
    }
    user = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
  }
  return user;
}

// Create or get user + start configurable trial via Whop (preferred) or Stripe Checkout
app.post('/api/create-checkout', async (req, res) => {
  try {
    const provider = paymentProvider();
    if (!provider) {
      return res.status(503).json({ error: 'Payments are not configured. Add WHOP_CHECKOUT_URL or Stripe keys to your environment.' });
    }

    const { email: rawEmail, password, trialDays: requestedTrialDays, billing } = req.body;
    const email = normalizeEmail(rawEmail);
    if (!email || !email.includes('@')) return res.status(400).json({ error: 'Valid email required' });

    const effectiveTrialDays = (typeof requestedTrialDays === 'number' && requestedTrialDays > 0)
      ? requestedTrialDays
      : TRIAL_DAYS;

    if (provider === 'whop') {
      const billingCycle = String(billing || 'monthly').toLowerCase() === 'yearly' ? 'yearly' : 'monthly';
      await upsertTrialCheckoutUser(email, password, effectiveTrialDays);
      return res.json({
        url: buildWhopCheckoutUrl(email, billingCycle),
        provider: 'whop',
        billing: billingCycle,
      });
    }

    const passwordHash = await hashPassword(password);
    let user = db.prepare('SELECT * FROM users WHERE email = ?').get(email);

    if (!user) {
      const customer = await stripe.customers.create({ email });
      db.prepare(`
        INSERT INTO users (email, stripe_customer_id, status, trial_end, access_granted, password_hash)
        VALUES (?, ?, 'trialing', datetime('now', '+${effectiveTrialDays} days'), 1, ?)
      `).run(email, customer.id, passwordHash);
      user = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
    } else {
      const customerId = await ensureStripeCustomer(user, email);
      user = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
      if (passwordHash) {
        db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(passwordHash, user.id);
      }
      if (!user.trial_end) {
        db.prepare(`UPDATE users SET trial_end = datetime('now', '+${effectiveTrialDays} days') WHERE id = ?`).run(user.id);
      }
      if (!user.access_granted) {
        db.prepare('UPDATE users SET access_granted = 1 WHERE id = ?').run(user.id);
      }
      user.stripe_customer_id = customerId;
    }

    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      customer: user.stripe_customer_id,
      customer_email: user.stripe_customer_id ? undefined : email,
      line_items: [{
        price: process.env.STRIPE_PRICE_ID,
        quantity: 1,
      }],
      subscription_data: {
        trial_period_days: effectiveTrialDays,
      },
      success_url: `${APP_BASE_URL}/success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${APP_BASE_URL}/`,
      metadata: { email }
    });

    res.json({ url: session.url, provider: 'stripe' });
  } catch (err) {
    console.error('create-checkout error:', err);
    const status = err?.statusCode || 500;
    const message = err?.raw?.message || err?.message || 'Could not start checkout';
    res.status(status).json({ error: message });
  }
});

// Tester signup: email-only, no card, full access for TESTER_TRIAL_DAYS (default 14), then expires automatically.
// No Stripe involved. Sends magic login link immediately.
app.post('/api/tester-signup', async (req, res) => {
  try {
    const { email: rawEmail, password } = req.body;
    const email = normalizeEmail(rawEmail);
    if (!email || !email.includes('@')) return res.status(400).json({ error: 'Valid email required' });

    const passwordHash = await hashPassword(password);
    if (!passwordHash) return res.status(400).json({ error: 'Password must be at least 8 characters.' });

    let user = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
    const trialEndExpr = `datetime('now', '+${TESTER_TRIAL_DAYS} days')`;

    if (!user) {
      db.prepare(`
        INSERT INTO users (email, status, trial_end, access_granted, password_hash)
        VALUES (?, 'trialing', ${trialEndExpr}, 1, ?)
      `).run(email, passwordHash);
      user = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
    } else {
      db.prepare(`
        UPDATE users SET status = 'trialing', trial_end = ${trialEndExpr}, access_granted = 1, password_hash = ?
        WHERE email = ?
      `).run(passwordHash, email);
      user = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
    }

    const token = require('crypto').randomBytes(32).toString('hex');
    const expires = new Date(Date.now() + 15 * 60 * 1000).toISOString();
    db.prepare('INSERT OR REPLACE INTO magic_tokens (token, email, expires_at) VALUES (?, ?, ?)').run(token, email, expires);

    try {
      await sendMagicLink(email, token, { isTester: true });
    } catch (emailErr) {
      console.error('tester-signup magic email error (non-fatal):', emailErr);
    }

    const jwtToken = issueUserJwt(user);
    res.json({
      success: true,
      token: jwtToken,
      email: user.email,
      message: `Your ${TESTER_TRIAL_DAYS}-day tester access is active. You can log in with your password or the magic link we emailed.`
    });
  } catch (err) {
    console.error('tester-signup error:', err);
    res.status(500).json({ error: 'Could not create tester access. Please try again.' });
  }
});

// Magic link login request
app.post('/api/request-login', async (req, res) => {
  try {
    const email = normalizeEmail(req.body?.email);
    if (!email) return res.status(400).json({ error: 'Email required' });

    const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
    if (!user) return res.status(404).json({ error: 'No account with that email. Use the trial form on the landing or the tester signup (no card) below.' });

    // Create short-lived token
    const token = require('crypto').randomBytes(32).toString('hex');
    const expires = new Date(Date.now() + 15 * 60 * 1000).toISOString();
    db.prepare('INSERT OR REPLACE INTO magic_tokens (token, email, expires_at) VALUES (?, ?, ?)').run(token, email, expires);

    await sendMagicLink(email, token);
    res.json({ success: true, message: 'Check your email for a login link.' });
  } catch (err) {
    console.error('request-login error:', err);
    res.status(500).json({ error: 'Could not send login link' });
  }
});

// Password login (for accounts that have a password set via admin or future flows)
app.post('/api/login', async (req, res) => {
  try {
    const email = normalizeEmail(req.body?.email);
    const { password } = req.body || {};
    if (!email || !password) return res.status(400).json({ error: 'Email and password required' });

    const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
    if (!user) return res.status(401).json({ error: 'No account with that email' });

    if (!user.password_hash) {
      return res.status(400).json({ error: 'No password set on this account. Use the magic login link instead (or "Already have an account? Send me a login link").' });
    }

    const ok = await bcrypt.compare(password, user.password_hash);
    if (!ok) return res.status(401).json({ error: 'Invalid password' });

    // Access check (same as magic)
    const now = new Date();
    const trialValid = !!(user.trial_end && now < new Date(user.trial_end));
    const effectivelyTrialing = (user.status === 'trialing') && trialValid;
    const hasPaidOrFree = ['active', 'free', 'past_due'].includes(user.status) || !!user.manual_free;
    if (!user.access_granted || (!effectivelyTrialing && !hasPaidOrFree)) {
      return res.status(403).json({ error: 'Account access has been revoked or trial expired.' });
    }

    const token = jwt.sign({ email: user.email, id: user.id }, JWT_SECRET, { expiresIn: '30d' });
    res.json({ token, email: user.email });
  } catch (err) {
    console.error('login error:', err);
    res.status(500).json({ error: 'Login failed' });
  }
});

// Verify magic token and issue JWT
app.get('/api/verify-magic', (req, res) => {
  try {
    const { token } = req.query;
    if (!token) return res.status(400).json({ error: 'Token required' });

    const record = db.prepare('SELECT * FROM magic_tokens WHERE token = ?').get(token);
    if (!record || new Date(record.expires_at) < new Date()) {
      return res.status(400).json({ error: 'Invalid or expired token' });
    }

    const user = db.prepare('SELECT * FROM users WHERE email = ?').get(record.email);
    if (!user || !user.access_granted) {
      return res.status(403).json({ error: 'Account access revoked' });
    }

    // Issue JWT (7 days)
    const jwtToken = jwt.sign({ email: user.email, id: user.id }, JWT_SECRET, { expiresIn: '7d' });

    // Clean token
    db.prepare('DELETE FROM magic_tokens WHERE token = ?').run(token);

    // Return token for frontend to store
    res.json({ token: jwtToken, email: user.email, status: user.status });
  } catch (err) {
    console.error('verify-magic error:', err);
    res.status(500).json({ error: 'Verification failed' });
  }
});

// Get current user status
app.get('/api/me', requireAuth, (req, res) => {
  const u = req.userRecord;
  res.json({
    email: u.email,
    status: u.status,
    trial_end: u.trial_end,
    access_granted: !!u.access_granted,
    manual_free: !!u.manual_free
  });
});

// Public config for client (demo limit, trial length, etc.). No secrets.
app.get('/api/config', (req, res) => {
  res.json({
    demoLimit: DEMO_LIMIT,
    trialDays: TRIAL_DAYS,
    testerTrialDays: TESTER_TRIAL_DAYS,
    hasSTT: false,
    siteUrl: SHARE_SITE_URL,
    paymentProvider: paymentProvider(),
  });
});

app.post('/api/share', express.json({ limit: '32kb' }), (req, res) => {
  const body = req.body || {};
  const type = String(body.type || '').trim();
  if (!['verse', 'conversation'].includes(type)) {
    return res.status(400).json({ error: 'Invalid share type' });
  }

  let payload;
  if (type === 'verse') {
    const reference = String(body.reference || '').trim();
    const translation = String(body.translation || '').trim();
    const text = String(body.text || '').trim();
    if (!reference && !text) return res.status(400).json({ error: 'Verse share requires reference or text' });
    payload = { type: 'verse', reference, translation, text };
  } else {
    const question = String(body.question || '').trim().slice(0, 2000);
    const reply = String(body.reply || '').trim().slice(0, 8000);
    if (!reply) return res.status(400).json({ error: 'Conversation share requires a reply' });
    payload = { type: 'conversation', question, reply };
  }

  const id = newShareId();
  db.prepare('INSERT INTO shares (id, type, payload) VALUES (?, ?, ?)').run(id, type, JSON.stringify(payload));
  res.json({ id, url: `${SHARE_SITE_URL}/share/${id}` });
});

// === TTS: browser built-in system voices only (window.speechSynthesis) ===
app.get('/api/debug/tts', (req, res) => {
  res.json({ disabled: true, note: 'All speech output uses browser system voices via window.speechSynthesis only.' });
});

app.post('/api/tts', (req, res) => {
  return res.status(400).json({
    error: 'Server TTS disabled. This app uses only your device\'s built-in system voices (window.speechSynthesis).'
  });
});

// Simple admin (password protected via /admin UI or curls, for your full control to cut off/grant)
app.post('/api/admin/login', (req, res) => {
  if (req.body.password !== ADMIN_PASSWORD) return res.status(401).json({ error: 'Bad password' });
  const adminToken = jwt.sign({ role: 'admin' }, JWT_SECRET, { expiresIn: '4h' });
  res.json({ token: adminToken });
});

function requireAdmin(req, res) {
  const adminToken = req.headers.authorization?.split(' ')[1];
  try {
    const payload = jwt.verify(adminToken, JWT_SECRET);
    if (payload.role !== 'admin') throw new Error();
    return true;
  } catch {
    res.status(401).json({ error: 'Admin required' });
    return false;
  }
}

app.get('/api/admin/users', (req, res) => {
  if (!requireAdmin(req, res)) return;

  const users = db.prepare('SELECT id, email, status, trial_end, access_granted, manual_free, group_name, created_at FROM users ORDER BY created_at DESC').all();
  res.json(users);
});

app.post('/api/admin/delete-user', (req, res) => {
  if (!requireAdmin(req, res)) return;

  const email = (req.body.email || '').toLowerCase().trim();
  if (!email) return res.status(400).json({ error: 'Email required' });

  const user = db.prepare('SELECT id, email FROM users WHERE email = ?').get(email);
  if (!user) return res.status(404).json({ error: 'User not found' });

  db.prepare('DELETE FROM magic_tokens WHERE email = ?').run(email);
  db.prepare('DELETE FROM users WHERE email = ?').run(email);
  console.log(`[admin] deleted user ${email}`);
  res.json({ success: true, deleted: email });
});

app.post('/api/admin/set-access', (req, res) => {
  if (!requireAdmin(req, res)) return;

  const { email, access_granted, manual_free } = req.body;
  db.prepare(`
    UPDATE users SET access_granted = ?, manual_free = ? WHERE email = ?
  `).run(!!access_granted ? 1 : 0, !!manual_free ? 1 : 0, email);
  res.json({ success: true });
});

async function activateWhopMembership(payload, source = 'webhook', options = {}) {
  if (!whopMembershipIsAllowed(payload)) {
    console.warn(`[whop:${source}] ignored membership for plan ${whopPayloadPlanId(payload)}`);
    return null;
  }

  const email = whopPayloadEmail(payload);
  if (!email) {
    console.warn(`[whop:${source}] membership ${payload?.id || '(unknown)'} missing email`);
    return null;
  }

  const mappedStatus = mapWhopStatusToUserStatus(payload?.status);
  const accessGranted = ['trialing', 'active'].includes(mappedStatus) ? 1 : 0;
  const membershipId = payload?.id || null;
  const memberId = payload?.member?.id || null;
  const renewalEnd = payload?.renewal_period_end || null;

  let user = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
  if (!user) {
    if (renewalEnd) {
      db.prepare(`
        INSERT INTO users (email, status, trial_end, access_granted, whop_membership_id, whop_member_id)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(email, mappedStatus, renewalEnd, accessGranted, membershipId, memberId);
    } else {
      db.prepare(`
        INSERT INTO users (email, status, trial_end, access_granted, whop_membership_id, whop_member_id)
        VALUES (?, ?, datetime('now', '+${TRIAL_DAYS} days'), ?, ?, ?)
      `).run(email, mappedStatus, accessGranted, membershipId, memberId);
    }
    user = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
  } else {
    db.prepare(`
      UPDATE users
      SET status = ?,
          access_granted = ?,
          whop_membership_id = COALESCE(?, whop_membership_id),
          whop_member_id = COALESCE(?, whop_member_id),
          trial_end = COALESCE(?, trial_end)
      WHERE id = ?
    `).run(mappedStatus, accessGranted, membershipId, memberId, renewalEnd, user.id);
    user = db.prepare('SELECT * FROM users WHERE id = ?').get(user.id);
  }

  if (!accessGranted) {
    console.log(`[whop:${source}] deactivated ${email} (${mappedStatus})`);
    return user;
  }

  if (options.sendLoginEmail === false) {
    console.log(`[whop:${source}] activated ${email} (${mappedStatus})`);
    return user;
  }

  const token = require('crypto').randomBytes(32).toString('hex');
  const expires = new Date(Date.now() + 15 * 60 * 1000).toISOString();
  db.prepare('INSERT OR REPLACE INTO magic_tokens (token, email, expires_at) VALUES (?, ?, ?)').run(token, email, expires);

  try {
    await sendMagicLink(email, token, {
      subject: 'Your Word in Context trial is ready — log in here',
      htmlPrefix: `<p>Your Whop checkout is complete and your <strong>${TRIAL_DAYS}-day trial</strong> is active.</p>`
    });
    console.log(`[whop:${source}] activated ${email} (${mappedStatus}) and sent login link`);
  } catch (emailErr) {
    console.error(`[whop:${source}] activated ${email} but login email failed:`, emailErr);
  }

  return user;
}

async function handleWhopTrialEndingSoon(payload, source = 'webhook') {
  if (!whopMembershipIsAllowed(payload)) return null;

  const email = whopPayloadEmail(payload);
  if (!email) {
    console.warn(`[whop:${source}] trial_ending_soon missing email`);
    return null;
  }

  const manageUrl = whopPayloadManageUrl(payload);
  const trialEnd = formatWhopDate(payload?.renewal_period_end) || 'soon';
  const loginUrl = `${APP_BASE_URL}/`;

  await sendWhopNotificationEmail(email, {
    subject: 'Your Word in Context free trial ends soon',
    html: `
      <p>Hi — your <strong>free trial</strong> for <strong>The Word in Context</strong> ends on <strong>${trialEnd}</strong>.</p>
      <p>After that, your subscription continues automatically at the plan you chose (monthly or yearly) unless you cancel before the trial ends.</p>
      <p><a href="${manageUrl}">Manage or cancel your subscription</a></p>
      <p><a href="${loginUrl}">Open The Word in Context</a></p>
      <p><small>Questions? Email <a href="mailto:hello@stewardoftheking.com">hello@stewardoftheking.com</a>. We will never sell your information.</small></p>
    `,
  });
  console.log(`[whop:${source}] trial-ending reminder sent to ${email}`);
  return email;
}

async function handleWhopPaymentFailed(payload, source = 'webhook') {
  const email = whopPayloadEmail(payload);
  if (!email) {
    console.warn(`[whop:${source}] payment.failed missing email`);
    return null;
  }

  const manageUrl = whopPayloadManageUrl(payload);
  const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
  if (user) {
    db.prepare(`UPDATE users SET status = 'past_due' WHERE id = ?`).run(user.id);
    console.log(`[whop:${source}] marked ${email} past_due (access kept until Whop deactivates membership)`);
  }

  await sendWhopNotificationEmail(email, {
    subject: 'Action needed — Word in Context payment failed',
    html: `
      <p>We couldn't process your latest payment for <strong>The Word in Context</strong>.</p>
      <p>Please update your payment method so your access isn't interrupted:</p>
      <p><a href="${manageUrl}">Update payment method</a></p>
      <p><a href="${APP_BASE_URL}/">Return to The Word in Context</a></p>
      <p><small>Need help? Email <a href="mailto:hello@stewardoftheking.com">hello@stewardoftheking.com</a>.</small></p>
    `,
  });
  console.log(`[whop:${source}] payment-failed notice sent to ${email}`);
  return email;
}

async function activateStripeCheckoutSession(session, source = 'webhook') {
  const email = normalizeEmail(session.metadata?.email || session.customer_email);
  if (!email) {
    console.warn(`[stripe:${source}] checkout session ${session.id} missing email metadata`);
    return null;
  }

  let user = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
  if (!user && session.customer && stripe) {
    user = db.prepare('SELECT * FROM users WHERE stripe_customer_id = ?').get(session.customer);
  }
  if (!user) {
    console.warn(`[stripe:${source}] no local user for checkout session ${session.id} (${email})`);
    return null;
  }

  const subscriptionId = typeof session.subscription === 'string' ? session.subscription : session.subscription?.id;
  db.prepare(`
    UPDATE users
    SET status = 'trialing',
        access_granted = 1,
        stripe_customer_id = COALESCE(?, stripe_customer_id),
        stripe_subscription_id = COALESCE(?, stripe_subscription_id)
    WHERE id = ?
  `).run(session.customer || null, subscriptionId || null, user.id);

  user = db.prepare('SELECT * FROM users WHERE id = ?').get(user.id);

  const token = require('crypto').randomBytes(32).toString('hex');
  const expires = new Date(Date.now() + 15 * 60 * 1000).toISOString();
  db.prepare('INSERT OR REPLACE INTO magic_tokens (token, email, expires_at) VALUES (?, ?, ?)').run(token, email, expires);

  try {
    await sendMagicLink(email, token, {
      subject: 'Your Word in Context trial is ready — log in here',
      htmlPrefix: `<p>Your Stripe checkout is complete and your <strong>${TRIAL_DAYS}-day trial</strong> is active.</p>`
    });
    console.log(`[stripe:${source}] activated ${email} and sent login link`);
  } catch (emailErr) {
    console.error(`[stripe:${source}] activated ${email} but login email failed:`, emailErr);
  }

  return user;
}

// Backup path when webhooks are missing/misconfigured: success page can confirm checkout directly.
app.post('/api/complete-checkout', async (req, res) => {
  try {
    const { sessionId, email: rawEmail } = req.body || {};
    const provider = paymentProvider();

    if (provider === 'whop') {
      const email = normalizeEmail(rawEmail);
      if (!email) return res.status(400).json({ error: 'email required' });

      const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
      if (!user) return res.status(404).json({ error: 'No account found for that email. Use the trial form first, then complete Whop checkout with the same email.' });

      if (!user.access_granted || !['trialing', 'active', 'free'].includes(user.status)) {
        return res.status(400).json({
          error: 'Checkout is still processing. Wait a moment, refresh, or use Log in at the top with the email + password you chose.'
        });
      }

      return res.json({
        success: true,
        email: user.email,
        message: 'Trial active. Check your email for a secure login link, or use the Log in button with the password you chose.'
      });
    }

    if (!stripeConfigured()) {
      return res.status(503).json({ error: 'Payments are not configured on this server.' });
    }
    if (!sessionId) return res.status(400).json({ error: 'sessionId required' });

    const session = await stripe.checkout.sessions.retrieve(sessionId);
    if (session.payment_status !== 'paid' && session.status !== 'complete') {
      return res.status(400).json({ error: 'Checkout is not complete yet. Refresh in a moment or use Log in at the top.' });
    }

    const user = await activateStripeCheckoutSession(session, 'complete-checkout');
    if (!user) return res.status(404).json({ error: 'Account not found for this checkout session.' });

    res.json({
      success: true,
      email: user.email,
      message: 'Trial activated. Check your email for a secure login link, or use the Log in button with the password you chose.'
    });
  } catch (err) {
    console.error('complete-checkout error:', err);
    res.status(500).json({ error: err?.message || 'Could not finalize checkout' });
  }
});

// Stripe webhook (for subscription updates)
app.post('/api/stripe-webhook', async (req, res) => {
  if (!stripe || !process.env.STRIPE_WEBHOOK_SECRET) {
    return res.status(503).send('Stripe webhook not configured');
  }

  const sig = req.headers['stripe-signature'];
  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error('Webhook signature error:', err);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  try {
    if (event.type === 'checkout.session.completed') {
      await activateStripeCheckoutSession(event.data.object, 'webhook');
    }

    if (event.type === 'customer.subscription.updated' || event.type === 'customer.subscription.deleted') {
      const sub = event.data.object;
      const customerId = sub.customer;
      const user = db.prepare('SELECT * FROM users WHERE stripe_customer_id = ?').get(customerId);
      if (user) {
        if (sub.status === 'trialing' && sub.trial_end) {
          db.prepare('UPDATE users SET trial_end = ? WHERE id = ?').run(new Date(sub.trial_end * 1000).toISOString(), user.id);
        }
        db.prepare(`
          UPDATE users SET status = ?, stripe_subscription_id = COALESCE(?, stripe_subscription_id)
          WHERE id = ?
        `).run(sub.status, sub.id, user.id);
      }
    }
  } catch (err) {
    console.error('Webhook handler error:', err);
    return res.status(500).json({ error: 'Webhook handler failed' });
  }

  res.json({ received: true });
});

app.post('/api/whop-webhook', async (req, res) => {
  if (!whopWebhookConfigured()) {
    return res.status(503).send('Whop webhook not configured');
  }

  let event;
  try {
    event = verifyWhopWebhook(req.body, req.headers);
  } catch (err) {
    console.error('Whop webhook signature error:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  try {
    const type = event?.type;
    const data = event?.data || {};

    if (type === 'membership.activated' || type === 'membership.went_valid') {
      await activateWhopMembership(data, 'webhook');
    } else if (type === 'membership.deactivated' || type === 'membership.went_invalid') {
      await activateWhopMembership({ ...data, status: 'canceled' }, 'webhook', { sendLoginEmail: false });
    } else if (type === 'payment.succeeded') {
      const membership = data?.membership || data;
      if (membership?.id || membership?.status) {
        await activateWhopMembership(membership, 'webhook-payment');
      } else {
        const email = whopPayloadEmail(data);
        if (email) {
          const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
          if (user) {
            db.prepare(`UPDATE users SET status = 'active', access_granted = 1 WHERE id = ?`).run(user.id);
            console.log(`[whop:webhook-payment] marked ${email} active from payment.succeeded`);
          }
        }
      }
    } else if (type === 'membership.trial_ending_soon') {
      await handleWhopTrialEndingSoon(data, 'webhook');
    } else if (type === 'payment.failed') {
      await handleWhopPaymentFailed(data, 'webhook');
    }
  } catch (err) {
    console.error('Whop webhook handler error:', err);
    return res.status(500).json({ error: 'Webhook handler failed' });
  }

  res.json({ received: true });
});

// Simple success page after checkout (Whop redirect or Stripe session_id)
app.get('/success', (req, res) => {
  const sessionId = String(req.query.session_id || '');
  const email = normalizeEmail(req.query.email || '');
  const provider = paymentProvider() || 'stripe';
  const paymentLabel = provider === 'whop' ? 'Whop' : 'Stripe';
  res.send(`
    <html><head><title>Success - The Word in Context</title></head><body style="font-family:sans-serif;padding:40px;max-width:600px;margin:0 auto;">
    <h1>🎉 Payment successful!</h1>
    <p>Your ${TRIAL_DAYS}-day trial has started.</p>
    <p id="status">Finalizing your account...</p>
    <p><a href="/">Return to home</a> and use the <strong>Log in</strong> button with the email + password you chose.</p>
    <p><a href="/app">Open the App</a></p>
    <p style="margin-top:20px;"><small>Domain: thewordincontext.org</small></p>
    <p><small>We will never sell your information. Chats stay in your browser only. Payments handled securely by ${paymentLabel}.</small></p>
    <script>
      const sessionId = ${JSON.stringify(sessionId)};
      let email = ${JSON.stringify(email)};
      const provider = ${JSON.stringify(provider)};
      try {
        if (!email) email = sessionStorage.getItem('wic_checkout_email') || '';
      } catch (e) {}
      const body = sessionId
        ? { sessionId }
        : (provider === 'whop' && email ? { email } : null);
      if (body) {
        fetch('/api/complete-checkout', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body)
        })
          .then(r => r.json())
          .then(data => {
            const el = document.getElementById('status');
            if (el) el.textContent = data.message || data.error || 'Account ready. Check your email or log in with your password.';
          })
          .catch(() => {
            const el = document.getElementById('status');
            if (el) el.textContent = 'Account ready. Use the Log in button at the top with your email + password, or request a magic link.';
          });
      } else {
        const el = document.getElementById('status');
        if (el) el.textContent = 'Use the Log in button at the top with your email + password, or request a magic link.';
      }
    </script>
    </body></html>
  `);
});


// Login page that handles magic token and stores it for the app
app.get('/login', (req, res) => {
  const token = req.query.token;
  if (!token) {
    return res.send('<p>No token provided. <a href="/">Go to The Word in Context</a></p>');
  }
  res.send(`
    <html><head><title>Logging in — The Word in Context</title></head><body style="font-family:sans-serif;padding:40px;max-width:520px;margin:0 auto;">
    <h2>The Word in Context</h2>
    <p>Verifying your login link...</p>
    <script>
      fetch('/api/verify-magic?token=${token}')
        .then(r => r.json())
        .then(data => {
          if (data.token) {
            localStorage.setItem('auth_token', data.token);
            localStorage.setItem('user_email', data.email || '');
            window.location.href = '/app';
          } else {
            document.body.innerHTML = '<p>Login failed: ' + (data.error || 'unknown') + '<br><a href="/">Return to site</a></p>';
          }
        })
        .catch(() => document.body.innerHTML = '<p>Login error. Try the link again or <a href="/">return to the site</a>.</p>');
    </script>
    </body></html>
  `);
});

// === Main chat endpoint (secure proxy) ===
// Supports both authenticated users (full trial/sub access via JWT) AND limited demo mode
// for the "Try the App" button on landing (no token = demo, client-enforced small limit).
// Demo requests bypass user DB/trial checks but still get full Bible-grounded Grok replies.
app.post('/api/chat', (req, res, next) => {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    // Demo / try-the-app limited mode (no login token). Client limits to a few responses.
    req.demo = true;
    return next();
  }
  // Has token: run the full auth + trial/sub access checks
  requireAuth(req, res, next);
}, async (req, res) => {
  try {
    if (req.demo) {
      const ip = req.ip || req.connection?.remoteAddress || 'unknown';
      if (!checkDemoThrottle(ip)) {
        console.warn('[demo] throttle hit for', ip);
        return res.status(429).json({ error: 'Too many demo requests from this IP. Please try the full trial.' });
      }
      console.log('[demo] limited demo chat request (client should enforce small response cap)');
    }
    const { messages, defaultTranslation } = req.body;

    if (!Array.isArray(messages) || messages.length === 0) {
      return res.status(400).json({ error: 'messages array required' });
    }

    if (!getXaiApiKey()) {
      return res.status(500).json({ error: 'Server not configured with XAI_API_KEY' });
    }

    // User-selected default English translation from Voice Settings (client sends defaultTranslation).
    // Only translations actually available on bible.helloao.org (no NASB/ESV/NKJV there).
    const ALLOWED_ENGLISH_TRANS = new Set(['BSB', 'eng_asv', 'eng_ylt', 'ENGWEBP']);
    const englishTrans = ALLOWED_ENGLISH_TRANS.has(defaultTranslation) ? defaultTranslation : 'BSB';

    // === Scripture grounding: fetch live text for refs in the CURRENT question ===
    // We pull from bible.helloao.org so quoted text is verbatim when available.
    // Do NOT carry old refs from earlier turns into unrelated new questions.
    function extractRefs(text) {
      if (!text) return [];
      // Matches common Bible refs: "John 3:16", "Galatians 6:1-10", "1 John 1:1", "Ps 23:1" etc.
      const regex = /\b(1\s?[A-Za-z]+|2\s?[A-Za-z]+|3\s?[A-Za-z]+|[A-Za-z]+)\s+\d+:\d+(?:-\d+)?\b/g;
      const matches = text.match(regex) || [];
      return [...new Set(matches.map(m => m.trim()))];
    }

    function isFollowUpToPriorPassage(text) {
      if (!text || typeof text !== 'string') return false;
      if (extractRefs(text).length > 0) return false;
      const t = text.toLowerCase().trim();
      return /\b(that|this|it|those|these|the verse|the passage|same (verse|passage|chapter)|explain (more|further|that)|go deeper|tell me more|elaborate|expand on)\b/.test(t)
        || /\bwhat about (it|that|verse|this)\b/.test(t);
    }

    function isWordStudyFollowUp(text) {
      if (!text || typeof text !== 'string') return false;
      if (extractRefs(text).length > 0) return false;
      const t = text.toLowerCase().trim();
      return /\b(greek|hebrew|aramaic|original language|transliterat|word study|lexical|underlying word|root word)\b/.test(t)
        || /\b(what does|meaning of|meanings of|define|definition of)\b/.test(t)
        || /\b(soul|spirit|dividing|divide|divided|merism|psyche|pneuma)\b/.test(t);
    }

    function isTopicalScriptureRequest(text) {
      if (!text || typeof text !== 'string') return false;
      if (extractRefs(text).length > 0) return false;
      const t = text.toLowerCase();
      return /\b(verses?|passages?|scriptures?|what does the bible say|bible say about|tell me about|scripture about|passages about|verses about)\b/.test(t)
        || /\babout\s+(healing|faith|love|fear|peace|marriage|salvation|forgiveness|prayer|wisdom|hope|sin|grace|mercy|judgment|angels|demons|money|work|family|children|death|resurrection)\b/.test(t);
    }

    const userMessages = messages.filter(m => m.role === 'user');
    const lastUserContent = userMessages[userMessages.length - 1]?.content || '';

    const blockedReason = getBlockedContentReason(lastUserContent);
    if (blockedReason) {
      console.warn('[chat] blocked request:', blockedReason.slice(0, 80));
      return res.status(400).json({ error: blockedReason });
    }

    let allRefs = [...new Set(extractRefs(lastUserContent))];

    const wordStudyFollowUp = isWordStudyFollowUp(lastUserContent);
    const passageFollowUp = isFollowUpToPriorPassage(lastUserContent);

    // Pull refs from earlier turns when the user is following up on the same passage or doing word study.
    if (allRefs.length === 0 && (passageFollowUp || wordStudyFollowUp)) {
      const recent = messages.slice(-8);
      for (const m of recent) {
        if (m.content && (m.role === 'user' || m.role === 'assistant')) {
          allRefs.push(...extractRefs(m.content));
        }
      }
      allRefs = [...new Set(allRefs)];
    }

    allRefs = allRefs.slice(0, 4);

    // Translation display names for citations and UI
    const transDisplayNames = {
      'BSB': 'Berean Standard Bible',
      'eng_asv': 'American Standard Version (ASV)',
      'eng_ylt': "Young's Literal Translation (YLT)",
      'ENGWEBP': 'World English Bible (WEB)',
      'grc_sbl': 'SBL Greek New Testament',
      'hbo_wlc': 'Westminster Leningrad Codex (Hebrew OT)',
      'heb_wlc': 'Westminster Leningrad Codex (Hebrew)',
      'grc_byz': 'Byzantine Greek New Testament',
      'grc_mtk': 'Majority Text Greek New Testament',
      'grc_gtr': 'Textus Receptus Greek New Testament'
    };

    function getDisplayTrans(t) {
      const key = (t || '').toLowerCase();
      for (const [k, nice] of Object.entries(transDisplayNames)) {
        if (k.toLowerCase() === key) return nice;
      }
      return t || 'Unknown';
    }

    const englishTransDisplay = getDisplayTrans(englishTrans);
    const userTransPref = `\n\nUSER PREFERENCE: The user has selected "${englishTransDisplay}" as their default English translation in Voice Settings. For all English scripture quotations and citations, use and cite "${englishTransDisplay}" by name unless the user explicitly asks for a different literal translation.`;

    async function fetchEnglishPassage(ref) {
      let passage = await fetchBiblePassage(ref, englishTrans);
      if (!passage && englishTrans !== 'BSB') {
        passage = await fetchBiblePassage(ref, 'BSB');
      }
      return passage;
    }

    const fetchedPassages = [];
    for (const ref of allRefs.slice(0, 4)) { // cap refs, will fetch originals too
      const english = await fetchEnglishPassage(ref);
      if (english) fetchedPassages.push(english);

      // Also fetch main original language text for Greek NT or Hebrew OT
      // The API will return null for incompatible (e.g. Hebrew trans on NT book)
      const grc = await fetchBiblePassage(ref, 'grc_sbl');
      if (grc) fetchedPassages.push(grc);

      const heb = await fetchBiblePassage(ref, 'hbo_wlc');
      if (heb) fetchedPassages.push(heb);
    }

    let bibleContext = '';
    if (fetchedPassages.length > 0) {
      bibleContext = fetchedPassages.map(p => {
        const disp = getDisplayTrans(p.translation);
        const label = (p.translation || '').match(/grc/i) ? 'ORIGINAL GREEK TEXT'
          : (p.translation || '').match(/hbo|heb.*wlc/i) ? 'ORIGINAL HEBREW TEXT'
          : 'ACCURATE BIBLE TEXT';
        return `\n\n[${label} — ${p.reference} (${disp})]\n${p.text}`;
      }).join('') + `\n\nGROUNDING NOTE: The blocks above are live verbatim text for references in the user's current question${allRefs.length && (passageFollowUp || wordStudyFollowUp) ? ' (follow-up to the prior passage)' : ''}. When quoting those exact references in English, use the [ACCURATE BIBLE TEXT] wording verbatim — do not substitute NASB, ESV, NKJV, or other disallowed translations. These blocks do NOT limit your answer: respond fully to whatever the user is asking now, including other books, chapters, themes, and verses across the whole Bible. For passages without a grounding block, quote from allowed helloao.org translations ("${englishTransDisplay}" unless the user asked for BSB, ASV, YLT, or WEB). Interpret Scripture only with Scripture. Mention the original language source only once per response when relevant.${wordStudyFollowUp ? ' WORD STUDY: The user is asking about original-language words in the grounded passage(s). Show Greek/Hebrew forms, transliteration, and lexical meaning as used in Scripture — do not refuse or answer only in English.' : ''}`;
    } else if (wordStudyFollowUp) {
      bibleContext = `\n\nWORD STUDY REQUEST: The user is asking about Greek, Hebrew, or Aramaic word meanings without naming a new reference. Use the passage(s) already discussed in this conversation. Show original-language forms, transliteration, literal glosses, and how The Word uses each term in context. Do not refuse as "beyond the text" — original-language study is the core purpose of this app.`;
    } else if (isTopicalScriptureRequest(lastUserContent)) {
      bibleContext = `\n\nTOPICAL REQUEST: The user is asking for scriptures about a subject without naming specific references. Search across the whole Bible (Old and New Testaments) and present every relevant passage using allowed translations ("${englishTransDisplay}" by default). Quote or cite each reference and explain what The Word explicitly says about the subject. Use "The Word states..." — never "the text states." Empty grounding blocks are expected — you are not limited to any earlier verse in this conversation.`;
    }

    // Build the messages for xAI
    const apiMessages = [
      { role: 'system', content: SYSTEM_PROMPT + userTransPref + bibleContext },
      ...messages.filter(m => m.role !== 'system')
    ];

    const rawReply = await callXaiChat(apiMessages);
    const reply = normalizeWordPhrasing(rawReply);

    // Post-hoc: the model may have referenced additional verses in its reply.
    // Fetch accurate live text for those too (including originals) so the client can show trustworthy sources.
    const replyRefs = extractRefs(reply);
    for (const ref of replyRefs) {
      if (!allRefs.includes(ref)) {
        const english = await fetchEnglishPassage(ref);
        if (english) fetchedPassages.push(english);
        const grc = await fetchBiblePassage(ref, 'grc_sbl');
        if (grc) fetchedPassages.push(grc);
        const heb = await fetchBiblePassage(ref, 'hbo_wlc');
        if (heb) fetchedPassages.push(heb);
      }
    }

    // Deduplicate sources for the response, using nice display names
    const seen = new Set();
    const sources = [];
    for (const p of fetchedPassages) {
      const disp = getDisplayTrans(p.translation);
      const key = `${p.reference}|${disp}`;
      if (!seen.has(key)) {
        seen.add(key);
        sources.push({ reference: p.reference, translation: disp, text: p.text, rawId: p.translation });
      }
    }

    res.json({ reply, sources });
  } catch (err) {
    console.error('xAI proxy error:', err?.status || '', err?.message || err);
    const status = err?.status && err.status >= 400 && err.status < 600 ? err.status : 503;
    res.status(status).json({ error: formatXaiError(err) });
  }
});

// Health check
app.get('/api/health', (req, res) => {
  res.json({
    ok: true,
    hasKey: !!getXaiApiKey(),
    xaiKeyLooksValid: xaiKeyLooksConfigured(),
    xaiKeyLength: getXaiApiKey().length,
    hasSTT: false,
    model: XAI_MODEL,
    deploy: process.env.RENDER_GIT_COMMIT || 'local'
  });
});

app.listen(PORT, () => {
  console.log(`\n📖 The Word in Context server running`);
  console.log(`   → http://localhost:${PORT}`);
  const keyLen = getXaiApiKey().length;
  console.log(`   xAI key loaded: ${xaiKeyLooksConfigured() ? `yes (${keyLen} chars)` : (keyLen ? 'present but may be placeholder/invalid' : 'NO — add to .env')} (model: ${XAI_MODEL})`);
  console.log(`   TTS: using only browser built-in system voices (window.speechSynthesis) — no server voices, no xAI voices`);
  console.log(`   STT: disabled (browser webkitSpeechRecognition only for hands-free wake "John", barge-in, and transcripts)`);
  console.log(`   Bible API: using bible.helloao.org (free, no key)`);
  console.log(`   Whop checkout: ${whopConfigured() ? 'configured' : 'NOT configured (set WHOP_CHECKOUT_URL_MONTHLY + WHOP_CHECKOUT_URL_YEARLY)'}`);
  console.log(`   Whop webhook secret: ${process.env.WHOP_WEBHOOK_SECRET ? 'set' : 'missing (add WHOP_WEBHOOK_SECRET for membership activation)'}`);
  console.log(`   Stripe (legacy): ${stripeConfigured() ? 'still configured' : 'off'}`);
  console.log(`   App base URL: ${APP_BASE_URL}\n`);
});
