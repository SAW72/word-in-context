require('dotenv').config();
const express = require('express');
const path = require('path');
const OpenAI = require('openai');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const Database = require('better-sqlite3');
const jwt = require('jsonwebtoken');
const { Resend } = require('resend');
const bcrypt = require('bcryptjs');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 8787;

// Raw body for Stripe webhook MUST be the very first middleware (before any express.json or body parsers)
// so that req.body is the raw Buffer/string for signature verification.
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
const DEMO_LIMIT = parseInt(process.env.DEMO_LIMIT || '10', 10);
const TESTER_TRIAL_DAYS = parseInt(process.env.TESTER_TRIAL_DAYS || '14', 10);

// Production note: When deploying (Render, Railway, etc.), set NODE_ENV=production
// and provide XAI_API_KEY + any future keys via the platform's environment variables.
// Free tiers may sleep the service — that's fine for early beta.

// === xAI Client (secure — key never leaves the server) ===
const xai = new OpenAI({
  apiKey: process.env.XAI_API_KEY,
  baseURL: 'https://api.x.ai/v1',
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

// === Strong System Prompt for "The Word in Context" ===
const SYSTEM_PROMPT = `You are an expert, reverent guide for studying the Hebrew, Aramaic, and Greek Scriptures in their original languages and literary contexts. You are the AI assistant inside the "Word in Context" Bible app.

CORE COMMITMENTS — never violate these:

Translation Policy
Use only the Berean Standard Bible (BSB) by default. Quote exclusively from English translations available on bible.helloao.org: Berean Standard Bible (BSB), American Standard Version (ASV), Young's Literal Translation (YLT), or World English Bible (WEB). Never quote NASB, ESV, NKJV, LSB, NIV, NLT, or The Message. When [ACCURATE BIBLE TEXT] grounding is provided below, quote that exact wording verbatim and cite the translation named in that block. When explaining any word or phrase, always begin with the literal English rendering before showing the underlying Hebrew or Greek.

Strict Context Rule
Answer strictly from what the biblical text explicitly says. Interpret Scripture only with Scripture. Never use any information, history, or context that comes from outside the biblical text itself.

No Inferences or Weighing of Passages
Never compare the number of passages on a topic, never weigh one set of verses against another, and never suggest that frequency of mention implies importance or emphasis. Address only what each specific text explicitly states.

Handling Traditions and Practices
When asked about any religious practice or tradition, first state exactly what the biblical text explicitly commands or institutes. If the text does not command or institute that practice, the AI may state: "This practice is not commanded in the text."

Original Languages
Use Hebrew or Greek words only when the user specifically asks for word study. Never speak or pronounce Hebrew or Greek words aloud unless requested.

Citations
Whenever you reference a verse, immediately follow it with the translation name, for example: "according to the Berean Standard Bible." Mention the original language source only once per response, such as "in the Hebrew text."

Tone and Boundaries
Stay humble, reverent, and strictly evidence-based. Use phrases like "the text indicates..." or "a more literal rendering would be..." Never add devotional warmth, encouragement, or application beyond the text.

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

  next();
});

// Serve beautiful public marketing landing page at root
// For closed beta: you can add simple password or email whitelist here before full auth.
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'landing.html'));
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
  const subject = options.subject || (isTester ? 'Your tester access to The Word in Context (14 days)' : 'Log in to The Word in Context');
  const prefix = options.htmlPrefix || (isTester 
    ? `<p>Welcome to <strong>The Word in Context</strong> as a tester!</p>
       <p>Your <strong>14-day tester access</strong> (no credit card required) has been activated. It ends automatically after 14 days unless extended.</p>`
    : `<p>Click to log in to <strong>The Word in Context</strong>:</p>`);
  const html = `
    ${prefix}
    <p><a href="${loginUrl}">Log in to your account</a></p>
    <p>This link expires in 15 minutes. If you didn't request this, ignore it.</p>
    <p><small>We will never sell your information. All chats are stored only in your browser. ${isTester ? 'This is tester access and will expire after the trial period.' : 'Payment info is handled securely by Stripe. Your conversations never leave your device.'}</small></p>
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

// Create or get user + start configurable trial via Stripe Checkout
app.post('/api/create-checkout', async (req, res) => {
  try {
    const { email, trialDays: requestedTrialDays } = req.body;
    if (!email || !email.includes('@')) return res.status(400).json({ error: 'Valid email required' });

    const effectiveTrialDays = (typeof requestedTrialDays === 'number' && requestedTrialDays > 0)
      ? requestedTrialDays
      : TRIAL_DAYS;

    let user = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
    if (!user) {
      // Create Stripe customer
      const customer = await stripe.customers.create({ email });
      db.prepare(`
        INSERT INTO users (email, stripe_customer_id, status, trial_end, access_granted)
        VALUES (?, ?, 'trialing', datetime('now', '+${effectiveTrialDays} days'), 1)
      `).run(email, customer.id);
      user = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
    }

    // Create Checkout for subscription with trial
    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      customer: user.stripe_customer_id,
      line_items: [{
        price: process.env.STRIPE_PRICE_ID,
        quantity: 1,
      }],
      subscription_data: {
        trial_period_days: effectiveTrialDays,
      },
      success_url: `${process.env.RENDER_EXTERNAL_URL || 'http://localhost:8787'}/success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${process.env.RENDER_EXTERNAL_URL || 'http://localhost:8787'}/`,
      metadata: { email }
    });

    res.json({ url: session.url });
  } catch (err) {
    console.error('create-checkout error:', err);
    res.status(500).json({ error: 'Could not start checkout' });
  }
});

// Tester signup: email-only, no card, full access for TESTER_TRIAL_DAYS (default 14), then expires automatically.
// No Stripe involved. Sends magic login link immediately.
app.post('/api/tester-signup', async (req, res) => {
  try {
    const { email } = req.body;
    if (!email || !email.includes('@')) return res.status(400).json({ error: 'Valid email required' });

    let user = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
    const trialEndExpr = `datetime('now', '+${TESTER_TRIAL_DAYS} days')`;

    if (!user) {
      db.prepare(`
        INSERT INTO users (email, status, trial_end, access_granted)
        VALUES (?, 'trialing', ${trialEndExpr}, 1)
      `).run(email);
      user = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
    } else {
      // Re-activate / extend as tester trial if they already exist
      db.prepare(`
        UPDATE users SET status = 'trialing', trial_end = ${trialEndExpr}, access_granted = 1
        WHERE email = ?
      `).run(email);
    }

    // Create short-lived magic token (same as normal login)
    const token = require('crypto').randomBytes(32).toString('hex');
    const expires = new Date(Date.now() + 15 * 60 * 1000).toISOString();
    db.prepare('INSERT OR REPLACE INTO magic_tokens (token, email, expires_at) VALUES (?, ?, ?)').run(token, email, expires);

    // Send custom tester magic link email
    await sendMagicLink(email, token, { isTester: true });

    res.json({ 
      success: true, 
      message: `Check your email for the secure login link. Your ${TESTER_TRIAL_DAYS}-day tester access (full features, no card) is now active and will end automatically.` 
    });
  } catch (err) {
    console.error('tester-signup error:', err);
    res.status(500).json({ error: 'Could not create tester access. Please try again.' });
  }
});

// Magic link login request
app.post('/api/request-login', async (req, res) => {
  try {
    const { email } = req.body;
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
app.post('/api/login', express.json({ limit: '10kb' }), async (req, res) => {
  try {
    const { email, password } = req.body || {};
    if (!email || !password) return res.status(400).json({ error: 'Email and password required' });

    const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email.toLowerCase());
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
    const hasPaidOrFree = ['active', 'free'].includes(user.status) || !!user.manual_free;
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
    hasSTT: false
  });
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

app.get('/api/admin/users', (req, res) => {
  const adminToken = req.headers.authorization?.split(' ')[1];
  try {
    const payload = jwt.verify(adminToken, JWT_SECRET);
    if (payload.role !== 'admin') throw new Error();
  } catch { return res.status(401).json({ error: 'Admin required' }); }

  const users = db.prepare('SELECT id, email, status, trial_end, access_granted, manual_free, created_at FROM users ORDER BY created_at DESC').all();
  res.json(users);
});

app.post('/api/admin/set-access', (req, res) => {
  const adminToken = req.headers.authorization?.split(' ')[1];
  try {
    const payload = jwt.verify(adminToken, JWT_SECRET);
    if (payload.role !== 'admin') throw new Error();
  } catch { return res.status(401).json({ error: 'Admin required' }); }

  const { email, access_granted, manual_free } = req.body;
  db.prepare(`
    UPDATE users SET access_granted = ?, manual_free = ? WHERE email = ?
  `).run(!!access_granted ? 1 : 0, !!manual_free ? 1 : 0, email);
  res.json({ success: true });
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
    const email = session.metadata?.email || session.customer_email;
    if (email) {
      db.prepare(`
        UPDATE users SET status = 'trialing', access_granted = 1 WHERE email = ?
      `).run(email);
    }
  }

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

// Simple success page after Stripe Checkout
app.get('/success', (req, res) => {
  res.send(`
    <html><head><title>Success - The Word in Context</title></head><body style="font-family:sans-serif;padding:40px;max-width:600px;margin:0 auto;">
    <h1>🎉 Payment successful!</h1>
    <p>Your ${TRIAL_DAYS}-day trial has started (or subscription activated).</p>
    <p>Check your email for a secure login link.</p>
    <p><a href="/app">Open the App</a> (log in with the link we emailed you)</p>
    <p style="margin-top:20px;"><small>Domain: thewordincontext.org</small></p>
    <p><small>We will never sell your information. Chats stay in your browser only. Powered by Stripe for secure payments.</small></p>
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

    if (!process.env.XAI_API_KEY) {
      return res.status(500).json({ error: 'Server not configured with XAI_API_KEY' });
    }

    // User-selected default English translation from Voice Settings (client sends defaultTranslation).
    // Only translations actually available on bible.helloao.org (no NASB/ESV/NKJV there).
    const ALLOWED_ENGLISH_TRANS = new Set(['BSB', 'eng_asv', 'eng_ylt', 'ENGWEBP']);
    const englishTrans = ALLOWED_ENGLISH_TRANS.has(defaultTranslation) ? defaultTranslation : 'BSB';

    // === Improved scripture grounding: scan recent conversation for references ===
    // We pull live from the public Bible API (https://bible.helloao.org) so the model
    // is always grounded in actual literal text rather than relying solely on training data.
    function extractRefs(text) {
      if (!text) return [];
      // Matches common Bible refs: "John 3:16", "Galatians 6:1-10", "1 John 1:1", "Ps 23:1" etc.
      const regex = /\b(1\s?[A-Za-z]+|2\s?[A-Za-z]+|3\s?[A-Za-z]+|[A-Za-z]+)\s+\d+:\d+(?:-\d+)?\b/g;
      const matches = text.match(regex) || [];
      return [...new Set(matches.map(m => m.trim()))];
    }

    // Collect refs from the last several messages (user questions + previous AI answers)
    // so we ground the whole current context, not just the very last user turn.
    let allRefs = [];
    const recent = messages.slice(-8);
    for (const m of recent) {
      if (m.content) allRefs.push(...extractRefs(m.content));
    }
    allRefs = [...new Set(allRefs)];

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
      }).join('') + `\n\nUse only the above literal text(s) as your source(s). Quote English verses verbatim from the [ACCURATE BIBLE TEXT] blocks — do not substitute NASB, ESV, NKJV, or any wording from memory. Answer strictly from what these texts explicitly say — interpret Scripture only with Scripture. For English quotations, cite "${englishTransDisplay}" unless the user asked for another helloao.org translation (BSB, ASV, YLT, WEB). Mention the original language source only once per response when relevant.`;
    }

    // Build the messages for xAI
    const apiMessages = [
      { role: 'system', content: SYSTEM_PROMPT + userTransPref + bibleContext },
      ...messages.filter(m => m.role !== 'system')
    ];

    const completion = await xai.chat.completions.create({
      model: 'grok-4.3',
      messages: apiMessages,
      temperature: 0.55,
      max_tokens: 1600,
    });

    const reply = completion.choices?.[0]?.message?.content || 'No response generated.';

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
    console.error('xAI proxy error:', err);
    const status = err.status || 500;
    const message = err.message || 'Unknown error calling xAI';
    res.status(status).json({ error: message });
  }
});

// Health check
app.get('/api/health', (req, res) => {
  res.json({
    ok: true,
    hasKey: !!process.env.XAI_API_KEY,
    hasSTT: false,
    model: 'grok-4.3'
  });
});

app.listen(PORT, () => {
  console.log(`\n📖 The Word in Context server running`);
  console.log(`   → http://localhost:${PORT}`);
  console.log(`   xAI key loaded: ${process.env.XAI_API_KEY ? 'yes' : 'NO — add to .env'} (used only for chat/LLM answers)`);
  console.log(`   TTS: using only browser built-in system voices (window.speechSynthesis) — no server voices, no xAI voices`);
  console.log(`   STT: disabled (browser webkitSpeechRecognition only for hands-free wake "John", barge-in, and transcripts)`);
  console.log(`   Bible API: using bible.helloao.org (free, no key)\n`);
});
