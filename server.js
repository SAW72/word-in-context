require('dotenv').config();
const express = require('express');
const path = require('path');
const fs = require('fs');
const OpenAI = require('openai');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const Database = require('better-sqlite3');
const jwt = require('jsonwebtoken');
const { Resend } = require('resend');
const bcrypt = require('bcryptjs');

const app = express();
const PORT = process.env.PORT || 8787;

// Raw body for Stripe webhook — MUST come *before* any body parser (including express.json())
// so req.body is a Buffer when we reach constructEvent for signature verification.
app.use('/api/stripe-webhook', express.raw({ type: 'application/json' }));

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

let db;
try {
  const dbDir = path.dirname(dbPath);
  if (!fs.existsSync(dbDir)) {
    fs.mkdirSync(dbDir, { recursive: true });
  }
  db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  console.log(`[DB] Opened successfully at ${dbPath}`);
} catch (err) {
  console.error(`[DB] CRITICAL: Failed to open ${dbPath}: ${err.message}`);
  if (onRender) {
    console.error('[DB] WARNING: Could not use /data. Falling back to ephemeral local DB. Users WILL be lost on redeploy!');
  }
  dbPath = path.join(__dirname, 'users.db');
  db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  console.log(`[DB] Using fallback local path: ${dbPath}`);
}

// Schema (CREATE IF NOT EXISTS) must run before any SELECT on users table.
// This is why a fresh disk volume was causing "no such table" and fallback.
try {
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      email TEXT UNIQUE NOT NULL,
      password_hash TEXT,
      stripe_customer_id TEXT,
      stripe_subscription_id TEXT,
      status TEXT DEFAULT 'trialing',
      trial_end TEXT,
      access_granted INTEGER DEFAULT 1,
      manual_free INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now'))
    );
  `);
  try { db.exec(`ALTER TABLE users ADD COLUMN password_hash TEXT`); } catch(e){}
  try { db.exec(`ALTER TABLE users ADD COLUMN group_name TEXT`); } catch(e){}
  db.exec(`
    CREATE TABLE IF NOT EXISTS magic_tokens (
      token TEXT PRIMARY KEY,
      email TEXT NOT NULL,
      expires_at TEXT NOT NULL
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
const DEMO_LIMIT = parseInt(process.env.DEMO_LIMIT || '5', 10);
const TESTER_TRIAL_DAYS = parseInt(process.env.TESTER_TRIAL_DAYS || '14', 10);

// Developer bypass: this email is always treated as having manual_free access.
// Use it (e.g. spence.wight@gmail.com) so you can easily log in and test during development
// without being cut off by trial expiration. The other test accounts (14-day tester and 7-day trial)
// should use their real DB flags so you can validate the full signup/login/trial-cutoff UX.
// Override or clear via DEV_BYPASS_EMAILS env (comma-separated). Remove before real production use.
const DEV_BYPASS_EMAILS = (process.env.DEV_BYPASS_EMAILS ||
  'spence.wight@gmail.com'
).split(',').map(e => e.trim().toLowerCase()).filter(Boolean);

function normalizeEmail(e) {
  return (e || '').trim().toLowerCase();
}

// Production note: When deploying (Render, Railway, etc.), set NODE_ENV=production
// and provide XAI_API_KEY + any future keys via the platform's environment variables.
// Free tiers may sleep the service — that's fine for early beta.

// === xAI Client (secure — key never leaves the server) ===
const xai = new OpenAI({
  apiKey: process.env.XAI_API_KEY,
  baseURL: 'https://api.x.ai/v1',
});

// Log the models your xAI key/account has access to.
// This is the easiest way to see "what model my api key is for".
// The key itself doesn't lock you to one model — you specify the model in each request
// (e.g. "grok-4.3" for chat, or specific audio models for TTS/STT/Voice Agent).
// Check your console.x.ai dashboard or these logs after deploy.
xai.models.list().then((list) => {
  const ids = list.data?.map(m => m.id) || [];
  console.log('xAI models available to this key:', ids.length ? ids : list);
}).catch((e) => {
  console.log('Could not list xAI models (check key permissions):', e.message);
});

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

// Hard daily response limit for demo mode (prevents refresh abuse)
// This is the authoritative cap. Client also enforces for UX.
const demoResponseCounts = new Map(); // ip -> { date: 'YYYY-MM-DD', count: number }
function checkAndIncrementDemoResponses(ip) {
  if (!ip) return true;
  const today = new Date().toISOString().slice(0, 10);
  let entry = demoResponseCounts.get(ip);
  if (!entry || entry.date !== today) {
    entry = { date: today, count: 0 };
  }
  if (entry.count >= DEMO_LIMIT) {
    demoResponseCounts.set(ip, entry);
    return false;
  }
  entry.count++;
  demoResponseCounts.set(ip, entry);
  return { allowed: true, remaining: Math.max(0, DEMO_LIMIT - entry.count) };
}

// === Strong System Prompt for "The Word in Context" ===
const SYSTEM_PROMPT = `You are an expert, reverent guide for studying the Hebrew, Aramaic, and Greek Scriptures in their original languages and literary contexts.

You are speaking with someone who wants to get as close as possible to what the original authors wrote and meant. All scripture discussed must be traceable to a specific, cited literal source.

CORE COMMITMENTS (never violate these):

1. TRANSLATION POLICY (strict)
   - NASB is the default English translation for explanations and teaching.
   - When the server supplies live grounding data for the current passage (e.g. [ACCURATE BIBLE TEXT — NASB], [ACCURATE BIBLE TEXT — BSB], etc.), use the exact English text from those blocks for all quotes and close analysis of that passage.
   - When explaining a word or phrase, start with the rendering from the supplied English block (or NASB when no fresh block is provided), then show the underlying Hebrew, Aramaic, or Greek only when it genuinely affects meaning.
   - Never quote or recommend dynamic or paraphrase translations (NIV, NLT, The Message, Passion, CEV, etc.).

2. ORIGINAL LANGUAGES APPROACH
   - Base every explanation on the original Hebrew, Aramaic, or Greek text.
   - When a key word or construction is significant, give the transliterated term, its core meaning in context, and how it is used here versus elsewhere in Scripture.
   - Only go deeper into grammar, full range of meaning, or the original script if the user specifically asks about that word or construction.

3. CONTEXT IS EVERYTHING ("The Word in Context")
   - Always locate the passage in its immediate literary context (what comes before and after).
   - Connect it to the book’s themes, genre, and historical setting when helpful.
   - For key terms, show how the same word or root is used elsewhere in Scripture (concordance-style insight).

4. HANDLING TRADITIONS & HISTORY
   - When users ask about church traditions, denominational teachings, or practices (head coverings, divorce and remarriage, church government, etc.), clearly distinguish what the original text actually says from later human traditions.
   - Explain the historical origin of those views when relevant, including the approximate time period and key figures or movements.
   - Be direct: many traditions developed later and were taught by men, not by God or the original apostles. The goal is to help the user return to what the text itself teaches.

5. WHY CONTEXT MATTERS
   - When appropriate, explain why reading Scripture in its original literary, linguistic, and historical context is essential.
   - The Bible calls us to remain devoted to the teachings of the apostles (what was delivered in the first century), not to later human traditions or teachings that developed afterward.

6. TONE & ACCURACY
   - Stay humble and evidence-based. Use phrases such as “The NASB reads…”, “In the original Greek this word carries the sense of…”, or “The historical record shows…”
   - Say “we do not know for certain” when the data is genuinely ambiguous.
   - Clearly separate what the text says from later theological or denominational interpretations.

7. VOICE & READABILITY
   - Responses will often be spoken aloud. Use natural, complete sentences and short paragraphs. Keep explanations clear, reverent, and conversational.

8. CITATIONS & SOURCING (MANDATORY)
   - Always cite your source naturally and immediately.
   - Use the English translation supplied in the live grounding blocks when available. Otherwise default to NASB.
   - For original languages, reference the SBL Greek New Testament (for the New Testament) or the Westminster Leningrad Codex (for the Hebrew Bible) as appropriate.
   - When the server provides [ACCURATE BIBLE TEXT], [ORIGINAL GREEK TEXT], or [ORIGINAL HEBREW TEXT] blocks, stay extremely faithful to those exact texts for any quotes or detailed analysis.

9. CONVERSATIONAL USE & TOPIC JUMPING
   - Keep the conversation natural and flowing, just like talking with a knowledgeable friend.
   - The user is free to jump between books, passages, or verses at any time (“Let’s talk about John 1”, then “Now what about 1 Corinthians 13”, then “Go back to that word in Romans”). Handle these shifts smoothly without friction.
   - When fresh live grounding blocks are supplied for a passage, use those blocks exclusively for accurate quotes and close textual work on that specific passage.
   - When the user moves to a new passage that does not yet have fresh grounding, still give a helpful, natural answer. Use general knowledge for overview and connections, but note when you are moving beyond the currently supplied live sources for detailed verse-by-verse or word-level work.
   - Never refuse or become artificially limited when the user changes topics. The grounding data exists to keep the conversation accurate, not to restrict what the user is allowed to ask about.

You are speaking with someone who wants to get as close as possible to what the original authors wrote and meant, while also understanding how later traditions sometimes moved away from that. All scripture discussed should be traceable to a specific, cited literal source.`;

// === Bible verse fetcher using the Free Use Bible API ===
// Supports English literals (NASB default via eng_lsv/LSV NASB 2020-style, plus BSB, ASV, YLT, WEB etc. via user picker) + original languages:
//   Greek NT: grc_sbl (SBL Greek New Testament), grc_byz, grc_mtk, grc_gtr (TR), etc.
//   Hebrew OT: hbo_wlc / heb_wlc (Westminster Leningrad Codex - standard Masoretic Text)
// Correct endpoints: https://bible.helloao.org/api/{TRANSLATION}/{BOOK}/{CHAPTER}.json
// Pass the exact id from /api/available_translations.json (e.g. 'eng_lsv' for NASB-style LSV, 'BSB', 'grc_sbl', 'hbo_wlc')
//
// The default English translation for live grounding is NASB (via LSV as the technical default for a modern literal NASB 2020-style text).
// Users can change it in 🔊 Voice Settings (the picker is preserved).
// Improvement: references to a chapter (e.g. "John 1", "the first chapter of John") or any verse
// in a chapter now return the *full chapter* text for the chosen English + original language. This ensures
// the model (and user via Sources UI) always has complete literal sources + context for
// the literary unit being discussed, instead of only the exact verses mentioned.
async function fetchBiblePassage(reference, translation = 'eng_lsv') {
  try {
    const cleaned = reference.trim().replace(/\s+/g, ' ');
    // Support bare chapters ("John 1", "John chapter 1", "Jn 1") as well as verses/ranges.
    // Book prefixes like "1 John", "2 Peter" etc. are handled.
    const match = cleaned.match(/^((?:1|2|3)\s*[A-Za-z]+|[A-Za-z]+)\s+(?:ch(?:apter|\.)?\s*)?(\d+)(?::(\d+)(?:-(\d+))?)?$/i);
    if (!match) return null;

    let book = match[1].trim();
    const chapter = match[2];

    // Always fetch the full chapter for complete literary context and "all the sources".
    // This fixes cases where only a few verses (e.g. John 1:1-3) were previously grounded
    // even when the user or model was discussing the whole chapter ("the book of John").
    const fetchStart = 1;
    const fetchEnd = 999;


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

    // Always extract *all* verses in the chapter for full literary context / complete sources.
    // Any reference to the chapter or a verse in it now supplies the entire chapter (BSB + Greek/Hebrew).
    const verses = [];
    for (const item of content) {
      if (item.type === 'verse' && typeof item.number === 'number') {
        if (item.number >= fetchStart && item.number <= fetchEnd) {
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

    // Label as the full chapter (since we always supply the complete chapter text for context).
    // Specific verse ranges are still respected in conversation, but grounding gives the whole literary unit.
    const refLabel = `${book} ${chapter}`;

    return {
      reference: refLabel,
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

app.use(express.json({ limit: '10mb' }));

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

    // Developer bypass: treat the configured dev email(s) as having manual_free access.
    // This lets you (spence.wight@gmail.com by default) always get in for testing,
    // while s.a.wight@gmail.com (14-day tester) and beyondbestservices@gmail.com (7-day trial)
    // follow the real trial/status/manual_free rules so you can test authentic UX flows.
    const isDevBypass = DEV_BYPASS_EMAILS.includes(user.email);
    const effectiveManualFree = !!user.manual_free || isDevBypass;

    // manual_free (or dev bypass) is the permanent access override.
    // It must bypass ALL trial/expiry/subscription checks. Admin panel uses separate auth.
    if (effectiveManualFree) {
      req.userRecord = user;  // return the real DB row (so /api/me still reports the true flags)
      next();
      return;
    }

    const now = new Date();
    const trialValid = !!(user.trial_end && now < new Date(user.trial_end));
    const hasPaidOrFree = ['active', 'free'].includes(user.status);

    if (user.status === 'trialing') {
      if (trialValid) {
        // Still within trial window
        req.userRecord = user;
        next();
        return;
      } else {
        // Trial expired for a trialing user (common for tester accounts or if webhook hasn't updated status yet)
        // Only force-cancel if NOT (manual_free or dev bypass)
        db.prepare('UPDATE users SET status = ? WHERE id = ?').run('canceled', user.id);
        return res.status(403).json({ error: 'Trial has expired. Please subscribe for continued access.' });
      }
    }

    if (hasPaidOrFree) {
      req.userRecord = user;
      next();
      return;
    }

    // Any other status (canceled, past_due, etc.) without manual free
    return res.status(403).json({ error: 'Subscription required or trial expired.' });
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
// - Fetches to xAI, bible.helloao.org etc. are allowed (11Labs support removed)
// - Any 'eval' usage from browser APIs or (more commonly) injected extension scripts doesn't
//   produce the "Content Security Policy of your site blocks the use of 'eval'" noise.
// In a real production SaaS deployment you would tighten this significantly (nonces, hashes,
// specific hosts, no unsafe-eval, etc.).
app.use((req, res, next) => {
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.set('Pragma', 'no-cache');
  res.set('Expires', '0');

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

  // Note: We intentionally do not set Cross-Origin-Embedder-Policy / Cross-Origin-Opener-Policy here.
  // Those headers (require-corp + same-origin) were causing scrolling, layout, and viewport problems
  // for users (page not scrollable, content not sitting right). We can re-add them later only on specific
  // paths if a future feature truly requires SharedArrayBuffer.

  next();
});

// Serve beautiful public marketing landing page at root
// For closed beta: you can add simple password or email whitelist here before full auth.
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'landing.html'));
});

// Serve the full chat app at /app (so landing can promote signups)
app.get('/app', (req, res) => {
  // Strong no-cache for the SPA entry point so deploys are picked up reliably
  // (browsers can still be stubborn — users should hard-refresh after deploys).
  res.set({
    'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate',
    'Pragma': 'no-cache',
    'Expires': '0',
    'Surrogate-Control': 'no-store'
  });

  // Ensure CSP allows eval for the app to work (browser APIs and any dynamic code).
  // This matches the dev middleware but is explicit for the main app HTML.
  res.set('Content-Security-Policy',
    "default-src 'self' 'unsafe-inline' 'unsafe-eval' blob: data: https: http: ws: wss:; " +
    "connect-src 'self' https: http: ws: wss:; " +
    "media-src 'self' blob: data: https:; " +
    "img-src 'self' data: https:; " +
    "script-src 'self' 'unsafe-inline' 'unsafe-eval' https:; " +
    "style-src 'self' 'unsafe-inline' https:;"
  );

  // (Isolation headers removed globally — see middleware above for explanation.
  // They were breaking normal scrolling and page layout for many users.)

  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Admin control panel - explicit route so /admin serves the panel (password protected inside via ADMIN_PASSWORD env)
// Must be before static middleware.
app.get('/admin', (req, res) => {
  console.log('[admin] serving admin panel page');
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

// Static assets (for any future images/css if split)
app.use(express.static(path.join(__dirname, 'public')));

// Silence favicon 404 spam (harmless but noisy in console)
app.get('/favicon.ico', (req, res) => res.status(204).end());

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

// === NEW: User login / account system with configurable trial (TRIAL_DAYS env) + Stripe ===

// Helper: send magic link email (or log in dev)
// options: { subject?, htmlPrefix?, isTester? }
async function sendMagicLink(email, token, options = {}) {
  const loginUrl = `${process.env.RENDER_EXTERNAL_URL || 'http://localhost:8787'}/login?token=${token}`;
  const isTester = !!options.isTester;
  const days = isTester ? TESTER_TRIAL_DAYS : TRIAL_DAYS;
  const subject = options.subject || (isTester ? `Your tester access to The Word in Context (${days} days)` : 'Log in to The Word in Context');
  // Build prefix cleanly (strip any source-code indentation from the literal)
  let prefix = options.htmlPrefix || (isTester
    ? `<p>Welcome to <strong>The Word in Context</strong> as a tester!</p>
<p>Your <strong>${days}-day tester access</strong> (no credit card required) has been activated. It ends automatically after ${days} days unless extended.</p>`
    : `<p>Click to log in to <strong>The Word in Context</strong>:</p>`);
  prefix = prefix.replace(/^\s+/gm, '').trim();

  // Build final HTML with join (never depends on template literal indentation in source)
  const html = [
    prefix,
    `<p><a href="${loginUrl}">Log in to your account</a></p>`,
    `<p>This link expires in 15 minutes. If you didn't request this, ignore it.</p>`,
    `<p><small>We will never sell your information. All chats are stored only in your browser. ${isTester ? `This is tester access and will expire after ${days} days.` : 'Payment info is handled securely by Stripe. Your conversations never leave your device.'}</small></p>`
  ].join('\n');

  let fromEmail = process.env.FROM_EMAIL || 'The Word in Context <no-reply@thewordincontext.org>';
  fromEmail = fromEmail.trim();
  // Force proper title-case for the display name part (handles "the Word...", "the word...", etc.)
  fromEmail = fromEmail.replace(/^the\s+/i, 'The ');

  console.log(`[sendMagicLink] to=${email} from=${fromEmail} resendConfigured=${!!resend} url=${loginUrl} (check Resend Emails dashboard too)`);
  console.log(`[sendMagicLink] actual from value being used: "${fromEmail}"`);

  if (resend) {
    const { data, error } = await resend.emails.send({
      from: fromEmail,
      to: email,
      subject,
      html
    });
    if (error) {
      console.error('[sendMagicLink] Resend returned error:', error);
      throw new Error('Failed to send email via Resend: ' + (error.message || JSON.stringify(error)));
    }
    console.log(`[sendMagicLink] Resend accepted send. id=${data && data.id ? data.id : 'n/a'}`);
  } else {
    console.log(`[MAGIC LINK for ${email}] ${loginUrl}`);
    throw new Error('RESEND_API_KEY not configured on server - cannot send magic links');
  }
}

// Create or get user + start configurable trial via Stripe Checkout
app.post('/api/create-checkout', async (req, res) => {
  try {
    const email = normalizeEmail(req.body.email);
    const { trialDays: requestedTrialDays, password } = req.body;
    if (!email || !email.includes('@')) return res.status(400).json({ error: 'Valid email required' });
    if (!password || password.length < 8) return res.status(400).json({ error: 'Password required (min 8 characters) to save login on this device' });

    const password_hash = await bcrypt.hash(password, 10);
    const effectiveTrialDays = (typeof requestedTrialDays === 'number' && requestedTrialDays > 0)
      ? requestedTrialDays
      : TRIAL_DAYS;

    const trialEnd = new Date(Date.now() + effectiveTrialDays * 24 * 60 * 60 * 1000).toISOString();

    let user = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
    if (!user) {
      // Create Stripe customer
      const customer = await stripe.customers.create({ email });
      db.prepare(`
        INSERT INTO users (email, password_hash, stripe_customer_id, status, trial_end, access_granted)
        VALUES (?, ?, ?, 'trialing', ?, 1)
      `).run(email, password_hash, customer.id, trialEnd);
      user = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
    } else if (!user.stripe_customer_id) {
      // Upgrade existing user (e.g. previous tester signup with no card) to have a Stripe customer
      const customer = await stripe.customers.create({ email });
      db.prepare(`UPDATE users SET password_hash = ?, stripe_customer_id = ? WHERE email = ?`).run(password_hash, customer.id, email);
      user = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
    } else {
      // Update password for existing
      db.prepare(`UPDATE users SET password_hash = ? WHERE email = ?`).run(password_hash, email);
    }

    // Create Checkout for subscription with trial
    // Main monthly price: price_1TgQpW9Hq4iefeFs9jsFfcI6 (set via STRIPE_PRICE_ID env)
    // Yearly available: price_1TgRqX9Hq4iefeFsCRXz5ES3
    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      customer: user.stripe_customer_id,
      line_items: [{
        price: process.env.STRIPE_PRICE_ID || 'price_1TgQpW9Hq4iefeFs9jsFfcI6',
        quantity: 1,
      }],
      subscription_data: {
        trial_period_days: effectiveTrialDays,
      },
      success_url: `${process.env.RENDER_EXTERNAL_URL || 'http://localhost:8787'}/app`,
      cancel_url: `${process.env.RENDER_EXTERNAL_URL || 'http://localhost:8787'}/`,
      metadata: { email }
    });

    // Send magic login link immediately (user provided a password, but magic link is convenient,
    // matching the "check your email" experience in the success page and tester flow).
    // Wrapped so a temporary email failure doesn't break the checkout.
    try {
      const token = require('crypto').randomBytes(32).toString('hex');
      const expires = new Date(Date.now() + 15 * 60 * 1000).toISOString();
      db.prepare('INSERT OR REPLACE INTO magic_tokens (token, email, expires_at) VALUES (?, ?, ?)').run(token, email, expires);

      await sendMagicLink(email, token);  // no isTester flag for paid trial
    } catch (e) {
      console.error('Failed to send magic link after initiating paid trial checkout (non-fatal):', e.message);
    }

    res.json({ url: session.url });
  } catch (err) {
    console.error('create-checkout error:', err);
    res.status(500).json({ error: 'Could not start checkout. ' + (err.message || 'Please try again.') });
  }
});

// Tester signup: email-only, no card, full access for TESTER_TRIAL_DAYS (default 14), then expires automatically.
// No Stripe involved. Sends magic login link immediately.
app.post('/api/tester-signup', async (req, res) => {
  try {
    const email = normalizeEmail(req.body.email);
    const password = req.body.password;
    if (!email || !email.includes('@')) return res.status(400).json({ error: 'Valid email required' });
    if (!password || password.length < 8) return res.status(400).json({ error: 'Password required (min 8 characters) for device-saved login' });

    const password_hash = await bcrypt.hash(password, 10);
    const trialEnd = new Date(Date.now() + TESTER_TRIAL_DAYS * 24 * 60 * 60 * 1000).toISOString();

    let user = db.prepare('SELECT * FROM users WHERE email = ?').get(email);

    if (!user) {
      db.prepare(`
        INSERT INTO users (email, password_hash, status, trial_end, access_granted)
        VALUES (?, ?, 'trialing', ?, 1)
      `).run(email, password_hash, trialEnd);
      user = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
    } else {
      // Re-activate / extend as tester trial if they already exist (update password if provided)
      db.prepare(`
        UPDATE users SET password_hash = ?, status = 'trialing', trial_end = ?, access_granted = 1
        WHERE email = ?
      `).run(password_hash, trialEnd, email);
    }

    // Create short-lived magic token (same as normal login) — still send initial link for convenience
    const token = require('crypto').randomBytes(32).toString('hex');
    const expires = new Date(Date.now() + 15 * 60 * 1000).toISOString();
    db.prepare('INSERT OR REPLACE INTO magic_tokens (token, email, expires_at) VALUES (?, ?, ?)').run(token, email, expires);

    // Send custom tester magic link email (optional first login / other devices)
    await sendMagicLink(email, token, { isTester: true });

    // Issue JWT so the client can auto-login and go straight to the app (exactly like the 7-day paid trial flow)
    const jwtToken = jwt.sign({ email: user.email, id: user.id }, JWT_SECRET, { expiresIn: '7d' });

    res.json({ 
      success: true, 
      token: jwtToken,
      email,
      message: `Account created. Logging you in... Your ${TESTER_TRIAL_DAYS}-day tester access is now active.` 
    });
  } catch (err) {
    console.error('tester-signup error:', err);
    res.status(500).json({ error: 'Could not create tester access. ' + (err.message || 'Please try again.') });
  }
});

// Magic link login request
app.post('/api/request-login', async (req, res) => {
  try {
    const email = normalizeEmail(req.body.email);
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
    res.status(500).json({ error: 'Could not send login link. ' + (err.message || 'Please try again.') });
  }
});

// New real password login (for device-saved credentials / password managers)
app.post('/api/login', async (req, res) => {
  try {
    const email = normalizeEmail(req.body.email);
    const password = req.body.password;
    if (!email || !password) return res.status(400).json({ error: 'Email and password required' });

    const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
    if (!user) {
      return res.status(401).json({ error: 'No account with that email. Use the trial form on the landing or the tester signup (no card) below.' });
    }
    if (!user.password_hash) {
      return res.status(401).json({ error: 'No password set for this account. Use the magic link login (or the "Tester Sign Up or Login" form above to set one), or request a magic link.' });
    }

    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }
    if (!user.access_granted) {
      return res.status(403).json({ error: 'Account access revoked' });
    }

    // Issue JWT (same as magic link)
    const jwtToken = jwt.sign({ email: user.email, id: user.id }, JWT_SECRET, { expiresIn: '7d' });

    // Clean any old magic tokens
    db.prepare('DELETE FROM magic_tokens WHERE email = ?').run(email);

    res.json({ 
      success: true, 
      token: jwtToken, 
      email: user.email,
      message: 'Logged in successfully. Credentials can now be saved by your browser.' 
    });
  } catch (err) {
    console.error('login error:', err);
    res.status(500).json({ error: 'Login failed' });
  }
});

// Allow logged-in users (e.g. via magic link) to set a password for future direct logins
app.post('/api/set-password', requireAuth, async (req, res) => {
  try {
    const { password } = req.body;
    if (!password || password.length < 8) {
      return res.status(400).json({ error: 'Password must be at least 8 characters' });
    }
    const password_hash = await bcrypt.hash(password, 10);
    const email = req.user.email;  // populated by requireAuth
    db.prepare(`UPDATE users SET password_hash = ? WHERE email = ?`).run(password_hash, email);
    res.json({ success: true, message: 'Password set successfully. You can now use email + password to log in directly from the landing page (browser can save it).' });
  } catch (err) {
    console.error('set-password error:', err);
    res.status(500).json({ error: 'Failed to set password' });
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
  const now = new Date();
  const trialExpired = u.trial_end && now >= new Date(u.trial_end);
  const isDevBypass = DEV_BYPASS_EMAILS.includes(u.email);

  // Keep status in sync for expired trials (testers etc.), but NEVER override/cancel manual_free accounts
  // or the developer bypass email (used for easy testing access).
  if (!u.manual_free && !isDevBypass && u.status === 'trialing' && trialExpired) {
    db.prepare('UPDATE users SET status = ? WHERE id = ?').run('canceled', u.id);
    u.status = 'canceled';
  }

  res.json({
    email: u.email,
    status: u.status,
    trial_end: u.trial_end,
    access_granted: !!u.access_granted,
    manual_free: !!u.manual_free || isDevBypass,
    has_password: !!u.password_hash
  });
});

// Public config for client (demo limit, trial length, etc.). No secrets.
app.get('/api/config', (req, res) => {
  res.json({
    demoLimit: DEMO_LIMIT,
    trialDays: TRIAL_DAYS,
    testerTrialDays: TESTER_TRIAL_DAYS,
    hasSTT: !!process.env.XAI_API_KEY
  });
});

// Debug endpoint - hit this after a redeploy to see if the persistent DB is working
app.get('/api/debug/db', (req, res) => {
  try {
    const count = db.prepare('SELECT COUNT(*) as count FROM users').get().count;
    const isPersistent = dbPath.includes('/data');
    res.json({
      dbPath,
      isPersistent,
      userCount: count,
      note: isPersistent 
        ? 'Using persistent disk. Users should survive redeploys.'
        : 'Using ephemeral storage. Users will be lost on redeploy. Make sure disk is attached in Render dashboard.'
    });
  } catch (e) {
    res.status(500).json({ error: e.message, dbPath });
  }
});

// === TTS proxy for seamless premium/custom voices ===
// Call this from the frontend instead of direct localhost.
// /api/tts supports:
// - provider: 'xai' when client's "Use Premium Grok Voices" toggle is on (xAI Grok voices Ara/Eve/etc).
// - no provider: legacy hosted (only if TTS_SERVER_URL set; manual non-hands-free use only).
// Client *never* sends provider=xai when the premium toggle is off — it uses local browser voices directly.
// Unset TTS_SERVER_URL to remove legacy hosted entirely. Uses same XAI_API_KEY as chat.
// Debug: GET /api/debug/tts to verify your key can do TTS.
app.get('/api/debug/tts', async (req, res) => {
  if (!process.env.XAI_API_KEY) return res.status(500).json({ error: 'No XAI_API_KEY in env' });
  try {
    const testRes = await fetch('https://api.x.ai/v1/tts', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.XAI_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        text: "Test from the app.",
        voice_id: "Eve",
        output_format: { codec: "mp3", sample_rate: 24000, bit_rate: 128000 },
        language: "en"
      })
    });
    const status = testRes.status;
    const text = await testRes.text();
    console.log('[DEBUG TTS] status:', status, 'body:', text.substring(0, 200));
    res.json({ status, success: testRes.ok, sample: text.substring(0, 200) });
  } catch (e) {
    console.error('[DEBUG TTS] error:', e);
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/tts', express.json({ limit: '1mb' }), async (req, res) => {
  try {
    const { text, voice, provider } = req.body || {};
    if (!text) return res.status(400).json({ error: 'text is required' });

    // Support both:
    // - provider: 'xai' for premium (xAI Grok voices Ara/Eve/Leo/Rex/Sal, highest paid tier) — used when the client's
    //   "Use Premium Grok Voices" toggle is on (affects both manual speak and hands-free auto-speak).
    // - default/no provider: legacy hosted (free neural, manual non-hands-free only) via TTS_SERVER_URL if set.
    // Same XAI_API_KEY as chat. xAI TTS: $15/1M chars.
    // To completely remove legacy hosted: unset TTS_SERVER_URL (client isolates to local + xAI premium only).
    // When the premium toggle is off, client always requests local browser voices (fast/reliable).
    const useXai = provider === 'xai';
    if (useXai && process.env.XAI_API_KEY) {
      console.log('[TTS] Attempting xAI TTS with voice_id:', voice || 'Eve', 'provider sent:', provider);
      const xaiRes = await fetch('https://api.x.ai/v1/tts', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${process.env.XAI_API_KEY}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          text: text,
          voice_id: voice || 'Eve',
          output_format: {
            codec: "mp3",
            sample_rate: 24000,
            bit_rate: 128000
          },
          language: "en"
        })
      });
      if (!xaiRes.ok) {
        const errText = await xaiRes.text();
        console.error('[TTS] xAI upstream error:', xaiRes.status, errText);
        // Forward real status for client handling (429 rate limit from xAI tiers, 403 auth, etc.)
        const status = xaiRes.status === 429 ? 429 : 502;
        return res.status(status).json({ error: 'xAI TTS generation failed', detail: errText, status: xaiRes.status });
      }
      // Success: clear any previous unavailable flag so the UI shows xAI voices next time
      // (client will also see success and can clear its local flag)
      const audioBuffer = await xaiRes.arrayBuffer();
      res.setHeader('Content-Type', 'audio/mpeg');
      return res.send(Buffer.from(audioBuffer));
    }

    // Old hosted (if TTS_SERVER_URL still set for legacy/manual use)
    const ttsBase = process.env.TTS_SERVER_URL || 'http://localhost:5050';
    const upstreamRes = await fetch(`${ttsBase.replace(/\/$/, '')}/v1/audio/speech`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        input: text,
        voice: voice || 'en-US-AvaNeural',
        response_format: 'mp3'
      })
    });

    if (!upstreamRes.ok) {
      const errText = await upstreamRes.text();
      console.error('[TTS] upstream error:', upstreamRes.status, errText);
      const status = upstreamRes.status === 429 ? 429 : 502;
      return res.status(status).json({ error: 'TTS generation failed', detail: errText, status: upstreamRes.status });
    }

    const audioBuffer = await upstreamRes.arrayBuffer();
    res.setHeader('Content-Type', 'audio/mpeg');
    res.send(Buffer.from(audioBuffer));
  } catch (e) {
    console.error('[TTS] proxy error:', e);
    res.status(500).json({ error: 'TTS proxy failed' });
  }
});

// === STT proxy for high-accuracy voice input (hands-free) ===
// xAI STT is extremely cheap ($0.10/hr batch, $0.20/hr streaming per audio hour).
// We use the same XAI_API_KEY you already set for chat.
// Client captures short utterance via MediaRecorder (only on hands-free commits), sends base64.
// We forward as proper multipart + heavy Bible book/chapter/verse keyterm boosting so
// "John one", "first John one", "Romans five", "1st Corinthians" etc. transcribe correctly on the first pass.
// This is the highest-leverage use of cheap STT for this app: better base text → far fewer grounding/ref extraction failures.
app.post('/api/stt', express.json({ limit: '10mb' }), async (req, res) => {
  try {
    const { audio, mime = 'audio/webm', language = 'en' } = req.body || {};
    if (!audio) return res.status(400).json({ error: 'audio (base64) is required' });

    const apiKey = process.env.XAI_API_KEY;
    if (!apiKey) return res.status(503).json({ error: 'STT not configured on server' });

    const audioBuffer = Buffer.from(audio, 'base64');

    // Skip very short live chunks (common in hands-free streaming) to avoid unnecessary upstream calls and potential 502s
    if (audioBuffer.length < 3000) { // ~0.3-0.5s of audio at typical rates — skip tiny live chunks to reduce upstream errors
      return res.json({ text: '' });
    }

    // Native FormData + Blob works on Node 18+ (Render uses 22.x)
    const form = new FormData();
    const blob = new Blob([audioBuffer], { type: mime });
    const ext = mime.includes('webm') ? 'webm' : (mime.includes('wav') ? 'wav' : 'mp3');
    form.append('file', blob, `utterance.${ext}`);
    form.append('language', language);

    // Bible-specific prompt for biasing (more compatible than dozens of keyterm fields).
    // Strongly prefer correct Bible refs so STT doesn't mangle "John 3:16", "Romans 5", "1 John" etc.
    const biblePrompt = 'Transcribe Bible references accurately. Prefer exact matches for: John, 1 John, 2 John, 3 John, Romans, Romans 5, 1 Corinthians, 2 Corinthians, Galatians, Ephesians, Philippians, Colossians, 1 Thessalonians, 2 Thessalonians, 1 Timothy, 2 Timothy, Titus, Philemon, Hebrews, James, 1 Peter, 2 Peter, Jude, Revelation, chapter, verse, one, two, three, four, five, six, first, second, third, Gospel of John, book of Romans, John 3:16, Romans chapter 5. Use numbers for chapters and verses. Avoid extra words like "cell".';
    form.append('prompt', biblePrompt);
    form.append('language', language);
    // Some STT endpoints (OpenAI compatible or xAI) expect a model.
    form.append('model', 'whisper-1');

    const upstream = await fetch('https://api.x.ai/v1/audio/transcriptions', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${apiKey}` },
      body: form
    });

    if (!upstream.ok) {
      const errText = await upstream.text();
      console.error('[STT] upstream error:', upstream.status, errText);
      // Preserve useful statuses (429 rate limit, 4xx client errors); only map 5xx to 502 for proxy
      const outStatus = upstream.status >= 500 ? 502 : upstream.status;
      return res.status(outStatus).json({ error: 'STT failed', detail: errText });
    }

    const data = await upstream.json();
    const text = (data.text || data.transcript || (typeof data === 'string' ? data : '') || '').trim();
    res.json({ text, raw: data });
  } catch (e) {
    console.error('[STT] proxy error:', e);
    res.status(500).json({ error: 'STT proxy failed' });
  }
});

// Simple admin (password protected via /admin UI or curls, for your full control to cut off/grant)
app.post('/api/admin/login', (req, res) => {
  if (req.body.password !== ADMIN_PASSWORD) return res.status(401).json({ error: 'Bad password' });
  const adminToken = jwt.sign({ role: 'admin' }, JWT_SECRET, { expiresIn: '4h' });
  res.json({ token: adminToken });
});

app.get('/api/admin/users', (req, res) => {
  const adminToken = req.headers.authorization?.split(' ')[1];
  try {
    const payload = jwt.verify(adminToken, JWT_SECRET);
    if (payload.role !== 'admin') throw new Error();
  } catch { return res.status(401).json({ error: 'Admin required' }); }

  try {
    const users = db.prepare('SELECT id, email, status, trial_end, access_granted, manual_free, group_name, created_at FROM users ORDER BY created_at DESC').all();
    res.json(users);
  } catch (e) {
    console.error('admin users error:', e);
    res.status(500).json({ error: 'DB error' });
  }
});

app.post('/api/admin/set-access', (req, res) => {
  const adminToken = req.headers.authorization?.split(' ')[1];
  try {
    const payload = jwt.verify(adminToken, JWT_SECRET);
    if (payload.role !== 'admin') throw new Error();
  } catch { return res.status(401).json({ error: 'Admin required' }); }

  try {
    const email = normalizeEmail(req.body.email);
    const { access_granted, manual_free, group_name } = req.body;
    const wantManualFree = !!manual_free;
    const wantAccess = !!access_granted;

    const params = [wantAccess ? 1 : 0, wantManualFree ? 1 : 0];
    let sql = `UPDATE users SET access_granted = ?, manual_free = ?`;
    if (group_name !== undefined) {
      sql += `, group_name = ?`;
      params.push(group_name || null);
    }
    if (wantManualFree) {
      sql += `, status = 'active'`;
    }
    sql += ` WHERE email = ?`;
    params.push(email);
    db.prepare(sql).run(...params);
    res.json({ success: true });
  } catch (e) {
    console.error('admin set-access error:', e);
    res.status(500).json({ error: 'DB error' });
  }
});

// Special extended tester / congregation invite (by admin only)
app.post('/api/admin/create-special-tester', (req, res) => {
  const adminToken = req.headers.authorization?.split(' ')[1];
  try {
    const payload = jwt.verify(adminToken, JWT_SECRET);
    if (payload.role !== 'admin') throw new Error();
  } catch { return res.status(401).json({ error: 'Admin required' }); }

  try {
    const email = normalizeEmail(req.body.email);
    const days = parseInt(req.body.days) || 30;
    const groupName = req.body.group_name || null;

    if (!email) return res.status(400).json({ error: 'email required' });

    const trialEnd = new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString();

    let user = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
    if (!user) {
      db.prepare(`
        INSERT INTO users (email, status, trial_end, access_granted, group_name)
        VALUES (?, 'trialing', ?, 1, ?)
      `).run(email, trialEnd, groupName);
      user = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
    } else {
      db.prepare(`
        UPDATE users SET status = 'trialing', trial_end = ?, access_granted = 1, group_name = COALESCE(?, group_name)
        WHERE email = ?
      `).run(trialEnd, groupName, email);
    }

    // Send magic link immediately
    const token = require('crypto').randomBytes(32).toString('hex');
    const expires = new Date(Date.now() + 15 * 60 * 1000).toISOString();
    db.prepare('INSERT OR REPLACE INTO magic_tokens (token, email, expires_at) VALUES (?, ?, ?)').run(token, email, expires);

    const loginUrl = `${process.env.RENDER_EXTERNAL_URL || 'http://localhost:8787'}/login?token=${token}`;
    const subject = `Your special access to The Word in Context (${days} days)`;
    const html = `
      <p>You've been given special extended access to <strong>The Word in Context</strong>.</p>
      <p>Your <strong>${days}-day access</strong> is now active. It ends automatically after ${days} days unless extended by the team.</p>
      <p><a href="${loginUrl}">Log in now</a></p>
      <p>This link expires in 15 minutes. If you need another, ask the admin.</p>
      <p><small>Conversations stay in your browser. For congregation/group use as arranged.</small></p>
    `;

    if (resend) {
      resend.emails.send({
        from: process.env.FROM_EMAIL || 'The Word in Context <no-reply@thewordincontext.org>',
        to: email,
        subject,
        html
      }).catch(e => console.error('special tester email error', e));
    }

    res.json({ success: true, message: `Special ${days}-day access created for ${email} (group: ${groupName || 'none'}). Magic link sent.` });
  } catch (e) {
    console.error('admin create-special-tester error:', e);
    res.status(500).json({ error: 'DB error' });
  }
});

// Bulk group / church grant
app.post('/api/admin/bulk-group-grant', (req, res) => {
  const adminToken = req.headers.authorization?.split(' ')[1];
  try {
    const payload = jwt.verify(adminToken, JWT_SECRET);
    if (payload.role !== 'admin') throw new Error();
  } catch { return res.status(401).json({ error: 'Admin required' }); }

  try {
    const { group_name, emails, days } = req.body;
    if (!group_name || !emails || !Array.isArray(emails)) {
      return res.status(400).json({ error: 'group_name and emails[] required' });
    }

    const trialEnd = days ? new Date(Date.now() + parseInt(days) * 24*60*60*1000).toISOString() : null;
    const status = trialEnd ? 'trialing' : 'active';

    let count = 0;
    emails.forEach(rawEmail => {
      const email = normalizeEmail(rawEmail);
      if (!email) return;
      let user = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
      if (!user) {
        db.prepare(`
          INSERT INTO users (email, status, trial_end, access_granted, group_name)
          VALUES (?, ?, ?, 1, ?)
        `).run(email, status, trialEnd, group_name);
      } else {
        db.prepare(`
          UPDATE users SET status = ?, trial_end = COALESCE(?, trial_end), access_granted = 1, group_name = ?
          WHERE email = ?
        `).run(status, trialEnd, group_name, email);
      }
      count++;
    });

    res.json({ success: true, granted: count, group: group_name });
  } catch (e) {
    console.error('admin bulk-group-grant error:', e);
    res.status(500).json({ error: 'DB error' });
  }
});

// Send The Word in Context Special (discounted $3/mo retention) offer
// Uses price_1TgRtD9Hq4iefeFs0WbyW9AD (or STRIPE_RETENTION_PRICE_ID env)
app.post('/api/admin/send-retention-offer', async (req, res) => {
  const adminToken = req.headers.authorization?.split(' ')[1];
  try {
    const payload = jwt.verify(adminToken, JWT_SECRET);
    if (payload.role !== 'admin') throw new Error();
  } catch { return res.status(401).json({ error: 'Admin required' }); }

  try {
    const email = normalizeEmail(req.body.email);
    const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
    if (!user || !user.stripe_customer_id) {
      return res.status(400).json({ error: 'User has no Stripe customer yet' });
    }

    // Use the provided Special / Retention price ID (The Word in Context Special - discounted $3/month)
    const retentionPrice = process.env.STRIPE_RETENTION_PRICE_ID || 'price_1TgRtD9Hq4iefeFs0WbyW9AD';
    if (!retentionPrice) {
      return res.status(500).json({ error: 'STRIPE_RETENTION_PRICE_ID not configured in env' });
    }

    try {
      // Create a checkout for the cheap retention plan, prefilled for their customer
      const session = await stripe.checkout.sessions.create({
        mode: 'subscription',
        customer: user.stripe_customer_id,
        line_items: [{ price: retentionPrice, quantity: 1 }],
        success_url: `${process.env.RENDER_EXTERNAL_URL || 'http://localhost:8787'}/app`,
        cancel_url: `${process.env.RENDER_EXTERNAL_URL || 'http://localhost:8787'}/`,
      });

      const html = `
        <p>Thanks for using The Word in Context.</p>
        <p>As a thank you for staying with us, we're offering the <strong>The Word in Context Special</strong> plan — the discounted $3/month rate (normally $4.99).</p>
        <p><a href="${session.url}">Switch to The Word in Context Special now</a></p>
        <p>If you have questions, just reply to this email.</p>
      `;
      if (resend) {
        await resend.emails.send({
          from: process.env.FROM_EMAIL || 'The Word in Context <no-reply@thewordincontext.org>',
          to: email,
          subject: 'The Word in Context Special — $3/month retention offer',
          html
        });
      }
      res.json({ success: true, message: `Retention checkout created and email sent to ${email}.` });
    } catch (err) {
      console.error('retention checkout error', err);
      res.status(500).json({ error: 'Failed to create retention checkout' });
    }
  } catch (e) {
    console.error('admin send-retention-offer error:', e);
    res.status(500).json({ error: 'DB error' });
  }
});

// Stripe webhook (for subscription updates)
app.post('/api/stripe-webhook', (req, res) => {
  const sig = req.headers['stripe-signature'];
  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error('Webhook signature error:', err);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    const email = normalizeEmail(session.metadata?.email || session.customer_email);
    if (email) {
      db.prepare(`
        UPDATE users SET status = 'trialing', access_granted = 1 WHERE email = ?
      `).run(email);
    }
  }

  // Optional: on cancel or past_due, you can add extra "The Word in Context Special" email here if desired
  // (the admin "The Word in Context Special" button also works for manual offers)

  if (event.type === 'customer.subscription.updated' || event.type === 'customer.subscription.deleted') {
    const sub = event.data.object;
    const customerId = sub.customer;
    const user = db.prepare('SELECT * FROM users WHERE stripe_customer_id = ?').get(customerId);
    if (user) {
      let newStatus = sub.status;
      if (sub.status === 'trialing' && sub.trial_end) {
        db.prepare('UPDATE users SET trial_end = ? WHERE id = ?').run(new Date(sub.trial_end * 1000).toISOString(), user.id);
      }
      if (sub.status === 'canceled' || sub.status === 'past_due') {
        // keep access until trial_end or manual
      }
      db.prepare('UPDATE users SET status = ? WHERE id = ?').run(newStatus, user.id);
    }
  }

  res.json({ received: true });
});

// Simple success page after Stripe Checkout - immediately redirects user into the app
app.get('/success', (req, res) => {
  res.send(`
    <html><head><title>Success - The Word in Context</title><meta http-equiv="refresh" content="1;url=/app"></head><body style="font-family:sans-serif;padding:40px;max-width:600px;margin:0 auto;">
    <h1>🎉 Payment successful!</h1>
    <p>Your ${TRIAL_DAYS}-day trial (or subscription) is now active. Redirecting you into the app...</p>
    <p>You can log in immediately using the password you chose on the landing page, or check your email for a secure magic login link (sent when you started checkout).</p>
    <p>If not redirected, <a href="/app">click here to open the App</a>.</p>
    <p style="margin-top:20px;"><small>Domain: thewordincontext.org</small></p>
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
      const demoCheck = checkAndIncrementDemoResponses(ip);
      if (!demoCheck || !demoCheck.allowed) {
        console.warn('[demo] hard response limit reached for', ip);
        return res.status(429).json({ 
          error: 'Demo limit reached for today. Please create a free account for full access.',
          demoRemaining: 0 
        });
      }
      console.log('[demo] limited demo chat request (client should enforce small response cap)');
      // Attach remaining so client can show accurate banner even after refresh
      req.demoRemaining = demoCheck.remaining;
    }
    const { messages } = req.body;
    // NASB is the default (technical fallback is eng_lsv = Literal Standard Version, a modern NASB 2020-style literal).
    // The client sends the user's chosen value from the Voice Settings picker (default_english_trans).
    const defaultTrans = (req.body && typeof req.body.defaultTranslation === 'string' && req.body.defaultTranslation.trim()) || 'eng_lsv';

    if (!Array.isArray(messages) || messages.length === 0) {
      return res.status(400).json({ error: 'messages array required' });
    }

    if (!process.env.XAI_API_KEY) {
      return res.status(500).json({ error: 'Server not configured with XAI_API_KEY' });
    }

    // === Improved scripture grounding: scan recent conversation for references ===
    // We pull live from the public Bible API (https://bible.helloao.org) so the model
    // is always grounded in actual literal text rather than relying solely on training data.
    function normalizeBibleTranscriptForRefs(text) {
      if (!text) return text;
      let t = ' ' + text + ' ';
      // Same common corrections as client for robustness
      // Specific for common STT mishearing of 1 John 1 as "first john one" or "1 john one"
      t = t.replace(/\bfirst\s+john\s+one\b/gi, '1 John 1');
      t = t.replace(/\b1\s+john\s+one\b/gi, '1 John 1');

      // Conversational follow-ups in the same thread ("John too", "John as well", "now John", "the other John")
      // after the user has been discussing John 1 (or Romans 5 etc.). This helps extractRefs produce
      // a usable ref so we fetch the literal + Greek for the new passage instead of the model saying
      // "I do not have the materials".
      t = t.replace(/\b(john|the book of john|the gospel of john)\s+(too|as well|also|next|the other)\b/gi, 'John 2');
      t = t.replace(/\b(romans)\s+(too|as well|also|next)\b/gi, 'Romans 6');
      t = t.replace(/\b(1 john|first john|i john)\s+(too|as well|also)\b/gi, '1 John 2');

      // Direct rescue for the exact jumbled STT output the user is seeing:
      // "John tell me about John two" → "two John two cell", "second John 2 cell", "2 John 2 cell", "john two cell"
      t = t.replace(/\btwo\s+john\s+two\b/gi, 'John 2');
      t = t.replace(/\bsecond\s+john\s+two\b/gi, 'John 2');
      t = t.replace(/\b2\s+john\s+2\b/gi, 'John 2');
      t = t.replace(/\bjohn\s+two\s+cell\b/gi, 'John 2');
      t = t.replace(/\bcell\b/gi, ''); // remove common STT garbage word that appears after refs
      t = t.replace(/\btwo\s+john\s+two\s+cell\b/gi, 'John 2');
      t = t.replace(/\bsecond\s+john\s+2\s+cell\b/gi, 'John 2');

      // Gospel of John first (strong patterns for "john one", "john 1", "the book of john one" etc.)
      // to ensure "John one" is the Gospel, not turned into 1 John.
      t = t.replace(/\b(john|the book of john|the gospel of john)\s*(chapter|ch\.?)?\s*(one|1|first)\b/gi, 'John 1');
      t = t.replace(/\b(john|the book of john|the gospel of john)\s*(chapter|ch\.?)?\s*(two|2|second)\b/gi, 'John 2');
      t = t.replace(/\b(john|the book of john|the gospel of john)\s*(chapter|ch\.?)?\s*(three|3|third)\b/gi, 'John 3');
      t = t.replace(/\b(john|the book of john|the gospel of john)\s*(chapter|ch\.?)?\s*(four|4)\b/gi, 'John 4');
      t = t.replace(/\b(john|the book of john|the gospel of john)\s*(chapter|ch\.?)?\s*(\d+)\b/gi, 'John $3');

      t = t.replace(/\b(one|1st|first| i |^i )\s+john\b/gi, ' 1 John ');
      t = t.replace(/\b(two|2nd|second| ii |^ii )\s+john\b/gi, ' 2 John ');
      t = t.replace(/\b(three|3rd|third| iii |^iii )\s+john\b/gi, ' 3 John ');

      t = t.replace(/\b(one|1st|first)\s+peter\b/gi, ' 1 Peter ');
      t = t.replace(/\b(two|2nd|second)\s+peter\b/gi, ' 2 Peter ');
      t = t.replace(/\b(one|1st|first)\s+corinthians\b/gi, ' 1 Corinthians ');
      t = t.replace(/\b(two|2nd|second)\s+corinthians\b/gi, ' 2 Corinthians ');
      t = t.replace(/\b(one|1st|first)\s+thessalonians\b/gi, ' 1 Thessalonians ');
      t = t.replace(/\b(two|2nd|second)\s+thessalonians\b/gi, ' 2 Thessalonians ');
      t = t.replace(/\b(one|1st|first)\s+timothy\b/gi, ' 1 Timothy ');
      t = t.replace(/\b(two|2nd|second)\s+timothy\b/gi, ' 2 Timothy ');
      t = t.replace(/\b(one|1st|first)\s+kings\b/gi, ' 1 Kings ');
      t = t.replace(/\b(two|2nd|second)\s+kings\b/gi, ' 2 Kings ');
      t = t.replace(/\b(one|1st|first)\s+samuel\b/gi, ' 1 Samuel ');
      t = t.replace(/\b(two|2nd|second)\s+samuel\b/gi, ' 2 Samuel ');
      t = t.replace(/\b(one|1st|first)\s+chronicles\b/gi, ' 1 Chronicles ');
      t = t.replace(/\b(two|2nd|second)\s+chronicles\b/gi, ' 2 Chronicles ');
      t = t.replace(/\bchapter\s+(one|first)\b/gi, 'chapter 1');
      t = t.replace(/\bchapter\s+(two|second)\b/gi, 'chapter 2');
      t = t.replace(/\bchapter\s+(three|third)\b/gi, 'chapter 3');
      t = t.replace(/\bchapter\s+four\b/gi, 'chapter 4');
      t = t.replace(/\b1\s+john\s+four\b/gi, '1 John 4');
      t = t.replace(/\bfirst\s+john\s+four\b/gi, '1 John 4');
      t = t.replace(/\bone\s+john\s+four\b/gi, '1 John 4');
      t = t.replace(/\b(1|2|3)\s+john\s+four\b/gi, '$1 John 4');
      t = t.trim();

      // Final safeguard pass: force gospel "John 1" (or other chapters) for any "john one/1/first" etc.
      // This catches cases where STT or wake word stripping left "john one" and earlier rules didn't trigger perfectly.
      // "john one" or "john 1" should be the Gospel of John, not 1 John.
      t = t.replace(/\bjohn\s+(one|1|first)\b/gi, 'John 1');
      t = t.replace(/\bjohn\s+(two|2|second)\b/gi, 'John 2');
      t = t.replace(/\bjohn\s+(three|3|third)\b/gi, 'John 3');
      t = t.replace(/\bjohn\s+(four|4)\b/gi, 'John 4');
      t = t.replace(/\bjohn\s+(five|5)\b/gi, 'John 5');
      t = t.replace(/\bjohn\s+(six|6)\b/gi, 'John 6');
      t = t.replace(/\bjohn\s+(seven|7)\b/gi, 'John 7');
      t = t.replace(/\bjohn\s+(eight|8)\b/gi, 'John 8');
      t = t.replace(/\bjohn\s+(nine|9)\b/gi, 'John 9');
      t = t.replace(/\bjohn\s+(ten|10)\b/gi, 'John 10');

      // Final stabilization pass: re-apply the most important gospel John fixes and clean any remaining junk.
      // This rescues cases where STT produces very jumbled output like "two John two cell".
      for (let pass = 0; pass < 2; pass++) {
        t = t.replace(/\btwo\s+john\s+two\b/gi, 'John 2');
        t = t.replace(/\bsecond\s+john\s+two\b/gi, 'John 2');
        t = t.replace(/\bjohn\s+two\s+cell\b/gi, 'John 2');
        t = t.replace(/\bcell\b/gi, '');
        t = t.replace(/\bjohn\s+(two|2|second)\b/gi, 'John 2');
      }

      return t;
    }

    function extractRefs(text) {
      if (!text) return [];
      // Normalize common STT / voice errors for Bible refs before extraction (helps grounding when mic input is noisy)
      text = normalizeBibleTranscriptForRefs(text);

      // Extra safety: convert any remaining word numbers for chapters in case normalize missed (e.g. "John two")
      text = text.replace(/\b(two|second)\b/gi, '2');
      text = text.replace(/\b(three|third)\b/gi, '3');
      text = text.replace(/\b(four)\b/gi, '4');
      text = text.replace(/\b(five)\b/gi, '5');
      text = text.replace(/\b(six)\b/gi, '6');
      text = text.replace(/\b(seven)\b/gi, '7');
      text = text.replace(/\b(eight)\b/gi, '8');
      text = text.replace(/\b(nine)\b/gi, '9');
      text = text.replace(/\b(ten)\b/gi, '10');

      // Matches common Bible refs, including bare chapters for full context:
      // "John 3:16", "John 1:1-10", "1 John 1:1", "John 1", "John chapter 1", "Jn 1", "Ps 23", etc.
      const regex = /\b((?:1|2|3)\s*[A-Za-z]+|[A-Za-z]+)\s+(?:ch(?:apter|\.)?\s*)?(\d+)(?::(\d+)(?:-(\d+))?)?\b/gi;
      let matches = text.match(regex) || [];
      // Normalize
      matches = matches.map(m => m.trim().replace(/\s+/g, ' '));

      // Explicitly catch "1 John ...", "2 Peter ..." patterns (global match can be derailed by preceding numbers)
      const numbered = text.match(/\b[1-3]\s+[A-Za-z]+\s+\d+(?::\d+(?:-\d+)?)?\b/gi) || [];
      matches = [...matches, ...numbered.map(m => m.trim().replace(/\s+/g, ' '))];

      // Known Bible book prefixes (to filter junk matches like "See 1", "also 1", "verse 1")
      const knownBooks = new Set([
        'gen','genesis','ex','exo','exodus','lev','leviticus','num','numbers','deut','deuteronomy',
        'josh','joshua','judg','judges','ruth',
        '1sam','1 samuel','2sam','2 samuel','1ki','1 kings','2ki','2 kings',
        '1chr','1 chronicles','2chr','2 chronicles','ezr','ezra','neh','nehemiah','est','esther',
        'job','ps','psalm','psalms','pro','prov','proverbs','ecc','eccl','ecclesiastes','sng','song',
        'isa','isaiah','jer','jeremiah','lam','lamentations','eze','ezekiel','dan','daniel',
        'hos','hosea','jol','joel','amo','amos','oba','obadiah','jon','jonah','mic','micah',
        'nam','nahum','hab','habakkuk','zep','zephaniah','hag','haggai','zec','zechariah','mal','malachi',
        'mat','matthew','mt','mrk','mark','mk','luk','luke','lk','jhn','john','jn',
        'act','acts','rom','romans','1co','1 corinthians','2co','2 corinthians',
        'gal','galatians','eph','ephesians','php','philippians','col','colossians',
        '1th','1 thessalonians','2th','2 thessalonians','1ti','1 timothy','2ti','2 timothy','tit','titus',
        'phm','philemon','heb','hebrews','jas','james',
        '1pe','1 peter','2pe','2 peter','1jn','1 john','2jn','2 john','3jn','3 john','jud','jude','rev','revelation'
      ]);

      matches = matches.filter(m => {
        const first = m.split(/\s+/)[0].toLowerCase().replace(/[^a-z0-9]/g, '');
        // must start with a known book or a number+book like "1john"
        return knownBooks.has(first) || knownBooks.has(m.toLowerCase().split(/\s+/).slice(0,2).join('').replace(/[^a-z0-9]/g,'')) || /^\d/.test(m);
      });

      return [...new Set(matches)];
    }

    // Collect refs from the last several messages (user questions + previous AI answers)
    // so we ground the whole current context, not just the very last user turn.
    let allRefs = [];
    const recent = messages.slice(-8);
    for (const m of recent) {
      if (m.content) allRefs.push(...extractRefs(m.content));
    }
    allRefs = [...new Set(allRefs)];

    // === Conversational follow-up / anaphora support ===
    // Users say things like "John too", "John as well", "now John", "the other one", "next chapter"
    // after previously discussing "John 1" or "Romans 5". We want seamless jumping without
    // the model saying "I don't have the materials for John 2".
    // Detect this in the latest user message and infer the logical next / related chapter
    // from what was already referenced in this conversation.
    try {
      const lastUser = [...recent].reverse().find(m => m.role === 'user' && m.content);
      if (lastUser && lastUser.content) {
        const lastNorm = normalizeBibleTranscriptForRefs(lastUser.content).toLowerCase();
        const isFollowUp = /\b(too|as well|also|next|other|following|as well|now|the other)\b/.test(lastNorm);

        if (isFollowUp) {
          // Build map of most recent chapter seen per book in this thread
          const lastChapterByBook = {};
          for (const r of allRefs) {
            const m = r.match(/^((?:1|2|3)?\s*[A-Za-z]+)\s+(\d+)/i);
            if (m) {
              const bookKey = m[1].toLowerCase().replace(/\s+/g, '');
              const ch = parseInt(m[2], 10);
              lastChapterByBook[bookKey] = Math.max(lastChapterByBook[bookKey] || 0, ch);
            }
          }

          // If user is saying "John too" / "John as well" etc. and we saw John 1 (or any John chapter), add John 2
          if ((lastNorm.includes('john') || lastNorm.includes('jhn')) && !lastNorm.match(/john\s*\d/)) {
            const prev = lastChapterByBook['john'] || lastChapterByBook['1john'] || lastChapterByBook['jhn'] || 1;
            const nextCh = prev + 1;
            allRefs.push(`John ${nextCh}`);
          }

          // Similar for other common books the user jumps between
          if ((lastNorm.includes('romans') || lastNorm.includes('rom')) && !lastNorm.match(/romans?\s*\d/)) {
            const prev = lastChapterByBook['romans'] || lastChapterByBook['rom'] || 5;
            allRefs.push(`Romans ${prev + 1}`);
          }

          // Add a couple more common ones for robustness (1 John, etc.)
          if (lastNorm.includes('1 john') || lastNorm.includes('first john') || lastNorm.includes('i john')) {
            // if they say "1 John too" after 1 John 1, go to 1 John 2, etc.
            const prev = lastChapterByBook['1john'] || lastChapterByBook['1 john'] || 1;
            allRefs.push(`1 John ${prev + 1}`);
          }
        }

        // Also catch bare "John 2", "chapter 2" etc. that might have been missed in a short follow-up
        // (the main extractRefs should catch most, but this is a safety net for very conversational phrasing)
        const extra = extractRefs(lastUser.content);
        for (const e of extra) {
          if (!allRefs.includes(e)) allRefs.push(e);
        }
      }
    } catch (e) {
      // non-fatal
    }

    allRefs = [...new Set(allRefs)];

    // Translation display names for citations and UI
    const transDisplayNames = {
      'BSB': 'Berean Standard Bible',
      'eng_lsv': 'Literal Standard Version (NASB 2020 style)',
      'LSV': 'Literal Standard Version (NASB 2020 style)',
      'eng_asv': 'American Standard Version (1901)',
      'ASV': 'American Standard Version (1901)',
      'eng_ylt': 'Young\'s Literal Translation',
      'YLT': 'Young\'s Literal Translation',
      'ENGWEBP': 'World English Bible',
      'WEB': 'World English Bible',
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

    const fetchedPassages = [];
    for (const ref of allRefs.slice(0, 8)) { // cap refs (raised to support more chapter context), will fetch originals too

      // Always fetch the English literal (NASB default via the user's chosen defaultTranslation from the picker; falls back to eng_lsv = LSV NASB 2020 style)
      const bsb = await fetchBiblePassage(ref, defaultTrans);
      if (bsb) fetchedPassages.push(bsb);

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
      }).join('') + '\n\nUse the above literal text(s) — including original Greek (SBLGNT etc.) and Hebrew (WLC) when provided — as your primary source(s). For any verse or phrase discussed, explicitly cite the translation/source (e.g. "SBL Greek New Testament" or "Westminster Leningrad Codex").';
    }

    // Build the messages for xAI (using the recommended Responses API per xAI quickstart)
    const apiMessages = [
      { role: 'system', content: SYSTEM_PROMPT + bibleContext },
      ...messages.filter(m => m.role !== 'system')
    ];

    const completion = await xai.responses.create({
      model: 'grok-4.3',
      input: apiMessages,
      temperature: 0.55,
      max_output_tokens: 1600,
    });

    const reply = completion.output_text || 'No response generated.';

    // Post-hoc: the model may have referenced additional verses in its reply.
    // Fetch accurate live text for those too (including originals) so the client can show trustworthy sources.
    const replyRefs = extractRefs(reply);
    for (const ref of replyRefs) {
      if (!allRefs.includes(ref)) {
        const bsb = await fetchBiblePassage(ref, defaultTrans);
        if (bsb) fetchedPassages.push(bsb);
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

    const response = { reply, sources };
    if (req.demo && typeof req.demoRemaining === 'number') {
      response.demoRemaining = req.demoRemaining;
    }
    res.json(response);
  } catch (err) {
    console.error('xAI proxy error:', err);
    let status = err.status || 500;
    let message = err.message || 'Unknown error calling xAI';
    // Handle xAI tier rate limits (RPM/TPM) gracefully
    if (status === 429 || /429|rate limit|too many requests/i.test(message)) {
      status = 429;
      message = 'xAI rate limited (your API tier caps RPM/TPM for the model). Please wait a moment and try again. Limits increase with cumulative spend on xAI.';
    }
    res.status(status).json({ error: message });
  }
});

// === Voices list via managed key (so users without personal key can still pick nice voices)
// /api/voices kept minimal (no managed premium voice list needed; xAI voices are known: Ara, Eve, Leo, Rex, Sal etc.).
// Premium is xAI TTS via the same XAI_API_KEY when the client sends provider or when no TTS_SERVER_URL is configured.
// Legacy TTS_SERVER_URL (edge-tts compatible) remains supported for optional free hosted neural (manual speak only).

// Health check
app.get('/api/health', (req, res) => {
  let dbInfo = { dbPath, isPersistent: dbPath.includes('/data'), userCount: -1, error: null };
  try {
    const count = db.prepare('SELECT COUNT(*) as c FROM users').get().c;
    dbInfo.userCount = count;
  } catch (e) {
    dbInfo.error = e.message;
  }
  res.json({
    ok: true,
    hasKey: !!process.env.XAI_API_KEY,
    hasHostedTTS: !!process.env.TTS_SERVER_URL,
    hasSTT: !!process.env.XAI_API_KEY,
    hasTTSKey: false,
    model: 'grok-4.3',
    db: dbInfo
  });
});

// Quick way to see what models your xAI key has access to (chat models mainly).
// For audio/voice (TTS/STT/Voice Agent) the models are on separate endpoints or specified differently — see x.ai docs or console.x.ai.
app.get('/api/models', async (req, res) => {
  try {
    const list = await xai.models.list();
    res.json({ models: list.data?.map(m => m.id) || list });
  } catch (e) {
    res.status(500).json({ error: 'Could not list models', detail: e.message });
  }
});

// Global error handler to ensure responses are always sent (prevents 502s from unhandled errors in routes)
app.use((err, req, res, next) => {
  console.error('Unhandled route error:', err);
  if (!res.headersSent) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.listen(PORT, () => {
  console.log(`\n📖 The Word in Context server running`);
  console.log(`   → http://localhost:${PORT}`);
  console.log(`   xAI key loaded: ${process.env.XAI_API_KEY ? 'yes' : 'NO — add to .env'}`);
  console.log(`   Legacy hosted TTS (TTS_SERVER_URL): ${process.env.TTS_SERVER_URL ? process.env.TTS_SERVER_URL : 'not set (premium now uses xAI TTS via your XAI_API_KEY)'}`);
  console.log(`   STT available (same XAI key, $0.10–0.20 per audio hour): ${process.env.XAI_API_KEY ? 'yes — will use for high-accuracy hands-free input' : 'no'}`);
  console.log(`   Bible API: using bible.helloao.org (free, no key)\n`);
});
