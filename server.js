require('dotenv').config();
const express = require('express');
const path = require('path');
const OpenAI = require('openai');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const Database = require('better-sqlite3');
const jwt = require('jsonwebtoken');
const { Resend } = require('resend');
const bcrypt = require('bcryptjs');

const app = express();
const PORT = process.env.PORT || 8787;

// === Simple SQLite DB for users (persistent on Render disk for beta; migrate to Postgres later) ===
const db = new Database(path.join(__dirname, 'users.db'));
db.pragma('journal_mode = WAL');

// Users table
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT UNIQUE NOT NULL,
    password_hash TEXT,                -- bcrypt hash for password login (optional for legacy magic-link users)
    stripe_customer_id TEXT,
    stripe_subscription_id TEXT,
    status TEXT DEFAULT 'trialing',  -- trialing, active, past_due, canceled, free, disabled
    trial_end TEXT,
    access_granted INTEGER DEFAULT 1,  -- 1 = can use, 0 = cut off
    manual_free INTEGER DEFAULT 0,     -- admin can grant free forever
    created_at TEXT DEFAULT (datetime('now'))
  );
`);

// Migration for existing DBs (safe if column already exists)
try {
  db.exec(`ALTER TABLE users ADD COLUMN password_hash TEXT`);
} catch (e) {
  if (!e.message.includes('duplicate column')) {
    console.error('Migration warning for password_hash:', e.message);
  }
}

// Magic tokens table (short lived)
db.exec(`
  CREATE TABLE IF NOT EXISTS magic_tokens (
    token TEXT PRIMARY KEY,
    email TEXT NOT NULL,
    expires_at TEXT NOT NULL
  );
`);

// === Email (Resend) ===
const resend = process.env.RESEND_API_KEY ? new Resend(process.env.RESEND_API_KEY) : null;

const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret-change-me';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'change-this';

// Configurable for easy tuning without code changes (set in Render env)
const TRIAL_DAYS = parseInt(process.env.TRIAL_DAYS || '7', 10);
const DEMO_LIMIT = parseInt(process.env.DEMO_LIMIT || '10', 10);
const TESTER_TRIAL_DAYS = parseInt(process.env.TESTER_TRIAL_DAYS || '14', 10);

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
const SYSTEM_PROMPT = `You are an expert, reverent guide for studying the Hebrew, Aramaic, and Greek Scriptures in their original languages and literary contexts.

CORE COMMITMENTS (never violate these):

1. TRANSLATION POLICY (strict)
   - Only quote from formal-equivalence / literal translations (user default e.g. LSV for NASB 2020 style, or ESV, NASB, NKJV, LSB, BSB, YLT, etc.).
   - Never recommend or rely on dynamic / paraphrase translations (NIV, NLT, The Message, Passion, CEV, etc.).
   - When explaining a word or phrase, always start with the literal rendering, then show the underlying Hebrew/Greek.

2. ORIGINAL LANGUAGES FIRST
   - When a Hebrew, Aramaic, or Greek word or construction is significant, give:
     • the actual word(s) in the original script when helpful
     • a clear transliteration
     • the range of meaning and grammatical notes
     • how it is used in this specific context vs. elsewhere in Scripture
   - Distinguish "what the text says" from later theological or denominational interpretations.

3. CONTEXT IS EVERYTHING ("The Word in Context")
   - Always locate the passage in its immediate literary context (what comes before and after).
   - Note the book-level themes, genre, and historical setting when they illuminate meaning.
   - For key terms, show how the same word or root is used elsewhere in Scripture (concordance-style insight).
   - Cross-references are welcome when genuinely illuminating.

4. TONE & ACCURACY
   - Humble and evidence-based. Use phrases like "the text indicates...", "a more literal rendering is...", "this construction often carries the sense of...".
   - Say "we do not know for certain" when the data is genuinely ambiguous.
   - Cite references precisely (e.g., "Genesis 1:1", "John 1:1-3 (BSB)").

5. VOICE & READABILITY
   - Responses will often be spoken aloud. Use natural, complete sentences. Structure with short paragraphs. Use bullets or numbered lists only when they genuinely help clarity.
   - Be concise yet thorough.

6. CITATIONS & SOURCING (MANDATORY — every response)
   - Whenever you quote, reference, or discuss any specific verse or passage, you MUST cite the source explicitly and naturally.
   - Format examples (use these or very close natural variations):
     "John 3:16 (Literal Standard Version or your chosen default) says: 'For God so loved the world...'"
     "According to the Berean Standard Bible, Galatians 6:7 states..."
     "In the Greek, John 1:1 (SBL Greek New Testament) reads: 'Ἐν ἀρχῇ ἦν ὁ λόγος...'"
     "The Hebrew of Genesis 1:1 (Westminster Leningrad Codex) begins: 'בְּרֵאשִׁית בָּרָא אֱלֹהִים...'"
   - If [ACCURATE BIBLE TEXT — ...], [ORIGINAL GREEK TEXT — ...], or [ORIGINAL HEBREW TEXT — ...] grounding data is provided, quote or stay extremely faithful to that exact text and use the listed source in the citation.
   - For the New Testament, when discussing wording, grammar, or key terms, quote the Greek from the SBL Greek New Testament (or Byzantine/Majority Text when relevant), citing "SBL Greek New Testament".
   - For the Old Testament / Hebrew Bible, quote the Hebrew from the Westminster Leningrad Codex (WLC), citing "Westminster Leningrad Codex".
   - Prefer literal English translations (user's chosen default, e.g. LSV/NASB-style or BSB, ESV, NASB, NKJV, LSB, etc.).
   - Because answers are frequently spoken, make the citations flow naturally in the spoken sentence so the listener hears the source (English or original language) clearly.
   - Never leave a scripture reference or quote without an immediate source citation.

You are speaking with someone who wants to get as close as possible to what the original authors wrote and meant. All scripture discussed must be traceable to a specific, cited literal source.`;

// === Bible verse fetcher using the Free Use Bible API ===
// Supports English literals (user's default e.g. eng_lsv/LSV NASB-style, BSB etc.) + original languages:
//   Greek NT: grc_sbl (SBL Greek New Testament), grc_byz, grc_mtk, grc_gtr (TR), etc.
//   Hebrew OT: hbo_wlc / heb_wlc (Westminster Leningrad Codex - standard Masoretic Text)
// Correct endpoints: https://bible.helloao.org/api/{TRANSLATION}/{BOOK}/{CHAPTER}.json
// Pass the exact id from /api/available_translations.json (e.g. 'eng_lsv' for NASB-style LSV, 'BSB', 'grc_sbl', 'hbo_wlc')
//
// The default English translation for live grounding is now user-configurable in the app (🔊 Voice Settings).
// Default is eng_lsv (Literal Standard Version — modern NASB 2020-style literal formal equivalence).
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

// Raw body for Stripe webhook
app.use('/api/stripe-webhook', express.raw({ type: 'application/json' }));

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
    const trialValid = !!(user.trial_end && now < new Date(user.trial_end));
    const effectivelyTrialing = (user.status === 'trialing') && trialValid;
    const hasPaidOrFree = ['active', 'free'].includes(user.status) || !!user.manual_free;
    if (!effectivelyTrialing && !hasPaidOrFree) {
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
  // Strong no-cache for the SPA entry point so deploys are picked up reliably
  // (browsers can still be stubborn — users should hard-refresh after deploys).
  res.set({
    'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate',
    'Pragma': 'no-cache',
    'Expires': '0',
    'Surrogate-Control': 'no-store'
  });
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
const fs = require('fs');
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

    // Send custom tester magic link email (optional first login)
    await sendMagicLink(email, token, { isTester: true });

    // Since password was provided on signup, issue JWT immediately so they can log in right away (browser can save credentials)
    const jwtToken = jwt.sign({ email: user.email, id: user.id }, JWT_SECRET, { expiresIn: '7d' });

    res.json({ 
      success: true, 
      token: jwtToken,
      email,
      message: `Account created with password. You can log in immediately below (or check email for magic link). Your ${TESTER_TRIAL_DAYS}-day tester access is now active.` 
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
    if (!user || !user.password_hash) {
      return res.status(401).json({ error: 'No password set for this account. Use the magic link login or sign up again with a password.' });
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
  res.json({
    email: u.email,
    status: u.status,
    trial_end: u.trial_end,
    access_granted: !!u.access_granted,
    manual_free: !!u.manual_free,
    has_password: !!u.password_hash
  });
});

// Public config for client (demo limit, trial length, etc.). No secrets.
app.get('/api/config', (req, res) => {
  res.json({
    demoLimit: DEMO_LIMIT,
    trialDays: TRIAL_DAYS,
    testerTrialDays: TESTER_TRIAL_DAYS
  });
});

// === TTS proxy for seamless premium/custom voices ===
// Call this from the frontend instead of direct localhost.
// Set TTS_SERVER_URL in env to your hosted TTS (e.g. your Render TTS service running the openai-edge-tts image, or a VPS).
// This keeps keys/server details on your server, works from the deployed HTTPS app.
// For custom "my voice": Clone on ElevenLabs, then we can extend this proxy to call ElevenLabs with your key + voice_id.
//
// Latency note: When "Use Premium Hosted Voices" is on, the reply text appears as soon as /api/chat finishes,
// but the voice audio requires a second round-trip: main app -> this proxy -> your TTS service (the separate
// openai-edge-tts container) -> synthesis -> MP3 back.
// Even on Hobby for the TTS service, cold starts + limited CPU commonly cause 15s–3min+ delays (or "text is there
// but voice never plays"). This exactly matches your report, and you noted it started after adding the hosted TTS
// (before that, pure local system voices were snappy). The 15s timeout + fallback to local (with visible note)
// is the current mitigation so it doesn't hang. Since you don't want to upgrade the TTS service, turning the
// premium toggle OFF will give you the fast local voices again. If you ever do upgrade, do it on the TTS service
// only (more CPU = much faster synthesis).
app.post('/api/tts', express.json({ limit: '1mb' }), async (req, res) => {
  try {
    const { text, voice } = req.body || {};
    if (!text) return res.status(400).json({ error: 'text is required' });

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
      return res.status(502).json({ error: 'TTS generation failed', detail: errText });
    }

    const audioBuffer = await upstreamRes.arrayBuffer();
    res.setHeader('Content-Type', 'audio/mpeg');
    res.send(Buffer.from(audioBuffer));
  } catch (e) {
    console.error('[TTS] proxy error:', e);
    res.status(500).json({ error: 'TTS proxy failed' });
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

  const users = db.prepare('SELECT id, email, status, trial_end, access_granted, manual_free, created_at FROM users ORDER BY created_at DESC').all();
  res.json(users);
});

app.post('/api/admin/set-access', (req, res) => {
  const adminToken = req.headers.authorization?.split(' ')[1];
  try {
    const payload = jwt.verify(adminToken, JWT_SECRET);
    if (payload.role !== 'admin') throw new Error();
  } catch { return res.status(401).json({ error: 'Admin required' }); }

  const email = normalizeEmail(req.body.email);
  const { access_granted, manual_free } = req.body;
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
    const email = normalizeEmail(session.metadata?.email || session.customer_email);
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
    const { messages } = req.body;
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

    // Translation display names for citations and UI
    const transDisplayNames = {
      'BSB': 'Berean Standard Bible',
      'eng_lsv': 'Literal Standard Version (NASB-style)',
      'LSV': 'Literal Standard Version (NASB-style)',
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

      // Always fetch the English literal (user's chosen default, e.g. eng_lsv for NASB-style)
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

    // Build the messages for xAI
    const apiMessages = [
      { role: 'system', content: SYSTEM_PROMPT + bibleContext },
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

    res.json({ reply, sources });
  } catch (err) {
    console.error('xAI proxy error:', err);
    const status = err.status || 500;
    const message = err.message || 'Unknown error calling xAI';
    res.status(status).json({ error: message });
  }
});

// === Voices list via managed key (so users without personal key can still pick nice voices)
// /api/voices kept minimal for now (ElevenLabs direct BYOK path in UI can still work client-side if user pastes a key).
// The primary seamless path (Premium Hosted toggle) hard-codes good neural voices server-side via TTS_SERVER_URL.

// (ElevenLabs managed /api/tts removed — using the edge-tts compatible proxy above when TTS_SERVER_URL is set.
// The hosted Microsoft neural voices via your Render TTS service (openai-edge-tts image) are the zero-friction
// path for customers via the "Use Premium Hosted Voices" toggle. No per-character costs.)

// Health check
app.get('/api/health', (req, res) => {
  res.json({
    ok: true,
    hasKey: !!process.env.XAI_API_KEY,
    hasHostedTTS: !!process.env.TTS_SERVER_URL,
    hasTTSKey: !!process.env.ELEVENLABS_API_KEY, // legacy for any ElevenLabs direct UI bits
    model: 'grok-4.3'
  });
});

app.listen(PORT, () => {
  console.log(`\n📖 The Word in Context server running`);
  console.log(`   → http://localhost:${PORT}`);
  console.log(`   xAI key loaded: ${process.env.XAI_API_KEY ? 'yes' : 'NO — add to .env'}`);
  console.log(`   Hosted TTS (TTS_SERVER_URL): ${process.env.TTS_SERVER_URL ? process.env.TTS_SERVER_URL : 'not set (will use localhost:5050 fallback for dev)'}`);
  console.log(`   Bible API: using bible.helloao.org (free, no key)\n`);
});
