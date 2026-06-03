require('dotenv').config();
const express = require('express');
const path = require('path');
const OpenAI = require('openai');

const app = express();
const PORT = process.env.PORT || 8787;

// Production note: When deploying (Render, Railway, etc.), set NODE_ENV=production
// and provide XAI_API_KEY + any future keys via the platform's environment variables.
// Free tiers may sleep the service — that's fine for early beta.

// === xAI Client (secure — key never leaves the server) ===
const xai = new OpenAI({
  apiKey: process.env.XAI_API_KEY,
  baseURL: 'https://api.x.ai/v1',
});

// === Strong System Prompt for "Word in Context" ===
const SYSTEM_PROMPT = `You are an expert, reverent guide for studying the Hebrew, Aramaic, and Greek Scriptures in their original languages and literary contexts.

CORE COMMITMENTS (never violate these):

1. TRANSLATION POLICY (strict)
   - Only quote from formal-equivalence / literal translations: ESV, NASB 2020, NKJV, LSB (Legacy Standard Bible), Berean Standard Bible (BSB), Young's Literal Translation, or similar.
   - Never recommend or rely on dynamic / paraphrase translations (NIV, NLT, The Message, Passion, CEV, etc.).
   - When explaining a word or phrase, always start with the literal rendering, then show the underlying Hebrew/Greek.

2. ORIGINAL LANGUAGES FIRST
   - When a Hebrew, Aramaic, or Greek word or construction is significant, give:
     • the actual word(s) in the original script when helpful
     • a clear transliteration
     • the range of meaning and grammatical notes
     • how it is used in this specific context vs. elsewhere in Scripture
   - Distinguish "what the text says" from later theological or denominational interpretations.

3. CONTEXT IS EVERYTHING ("Word in Context")
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
     "John 3:16 (Berean Standard Bible) says: 'For God so loved the world...'"
     "According to the Berean Standard Bible, Galatians 6:7 states..."
     "In the Greek, John 1:1 (SBL Greek New Testament) reads: 'Ἐν ἀρχῇ ἦν ὁ λόγος...'"
     "The Hebrew of Genesis 1:1 (Westminster Leningrad Codex) begins: 'בְּרֵאשִׁית בָּרָא אֱלֹהִים...'"
   - If [ACCURATE BIBLE TEXT — ...], [ORIGINAL GREEK TEXT — ...], or [ORIGINAL HEBREW TEXT — ...] grounding data is provided, quote or stay extremely faithful to that exact text and use the listed source in the citation.
   - For the New Testament, when discussing wording, grammar, or key terms, quote the Greek from the SBL Greek New Testament (or Byzantine/Majority Text when relevant), citing "SBL Greek New Testament".
   - For the Old Testament / Hebrew Bible, quote the Hebrew from the Westminster Leningrad Codex (WLC), citing "Westminster Leningrad Codex".
   - Prefer literal English translations: BSB (Berean Standard Bible), ESV, NASB, NKJV, LSB, etc.
   - Because answers are frequently spoken, make the citations flow naturally in the spoken sentence so the listener hears the source (English or original language) clearly.
   - Never leave a scripture reference or quote without an immediate source citation.

You are speaking with someone who wants to get as close as possible to what the original authors wrote and meant. All scripture discussed must be traceable to a specific, cited literal source.`;

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

app.use(express.json({ limit: '1mb' }));

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

// === Main chat endpoint (secure proxy) ===
app.post('/api/chat', async (req, res) => {
  try {
    const { messages } = req.body;

    if (!Array.isArray(messages) || messages.length === 0) {
      return res.status(400).json({ error: 'messages array required' });
    }

    if (!process.env.XAI_API_KEY) {
      return res.status(500).json({ error: 'Server not configured with XAI_API_KEY' });
    }

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
    for (const ref of allRefs.slice(0, 4)) { // cap refs, will fetch originals too
      // Always fetch the English literal (BSB)
      const bsb = await fetchBiblePassage(ref, 'BSB');
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
        const bsb = await fetchBiblePassage(ref, 'BSB');
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
app.get('/api/voices', async (req, res) => {
  const apiKey = process.env.ELEVENLABS_API_KEY;
  if (!apiKey) return res.status(503).json({ error: 'managed voices not configured' });
  try {
    const r = await fetch('https://api.elevenlabs.io/v1/voices', {
      headers: { 'xi-api-key': apiKey }
    });
    if (!r.ok) return res.status(r.status).send(await r.text());
    const data = await r.json();
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: 'failed to list voices' });
  }
});

// === TTS proxy using server-side ElevenLabs key (for low-cost subscription "managed voices") ===
// Users without a personal key (or who want included quota) use this.
// Cost is borne by the app/subscription fee. Add auth/rate-limiting per user later.
// IMPORTANT for low monthly fee viability: hard cap + cheapest model + log usage so owner can monitor burn.
app.post('/api/tts', express.json({ limit: '256kb' }), async (req, res) => {
  try {
    const { text, voiceId = 'XrExE9yKIg1WjnnlVkGX' } = req.body || {};
    if (!text || typeof text !== 'string' || text.trim().length === 0) {
      return res.status(400).json({ error: 'text is required' });
    }
    const apiKey = process.env.ELEVENLABS_API_KEY;
    if (!apiKey) {
      return res.status(500).json({ error: 'Server not configured with ELEVENLABS_API_KEY for managed voices' });
    }
    // Hard safety cap for (any) TTS via proxy. For user-provided keys, this is less critical but still protects.
    // Increased to allow longer complete responses with EL voices (~1-2 min speech possible).
    // Manual full speak from UI uses direct if key, but proxy path caps here.
    const safeText = text.slice(0, 2000);
    const model = 'eleven_turbo_v2_5'; // cheapest low-latency good quality model (Flash equiv)
    console.log(`[TTS managed] ${safeText.length} chars (capped), voice:${voiceId}, model:${model} — owner cost`);

    const r = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`, {
      method: 'POST',
      headers: {
        'Accept': 'audio/mpeg',
        'xi-api-key': apiKey,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        text: safeText,
        model_id: model,
        voice_settings: { stability: 0.55, similarity_boost: 0.8 }
      })
    });
    if (!r.ok) {
      const errText = await r.text().catch(() => '');
      console.error('[TTS managed] upstream error:', r.status, errText.slice(0, 200));
      return res.status(r.status).send(errText || 'TTS generation failed');
    }
    res.setHeader('Content-Type', r.headers.get('content-type') || 'audio/mpeg');
    res.setHeader('X-TTS-Chars-Used', String(safeText.length)); // for future client metering UI
    // Stream the audio back (no buffering whole file in memory)
    r.body.pipe(res);
  } catch (e) {
    console.error('TTS proxy error:', e);
    res.status(500).json({ error: 'TTS proxy failed' });
  }
});

// Health check
app.get('/api/health', (req, res) => {
  res.json({
    ok: true,
    hasKey: !!process.env.XAI_API_KEY,
    hasTTSKey: !!process.env.ELEVENLABS_API_KEY,
    model: 'grok-4.3'
  });
});

app.listen(PORT, () => {
  console.log(`\n📖 Word in Context server running`);
  console.log(`   → http://localhost:${PORT}`);
  console.log(`   xAI key loaded: ${process.env.XAI_API_KEY ? 'yes' : 'NO — add to .env'}`);
  console.log(`   ElevenLabs (managed TTS for subs): ${process.env.ELEVENLABS_API_KEY ? 'yes (owner pays for included quota)' : 'NO — add ELEVENLABS_API_KEY to .env for premium voices in low-fee plans'}`);
  console.log(`   Bible API: using bible.helloao.org (free, no key)\n`);
});
