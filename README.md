# 📖 The Word in Context

A secure, voice-first application for deep study of The Word — the Hebrew, Aramaic, and Greek Scriptures — using only literal, formal-equivalence translations.

**Tagline**: Getting as close as possible to what the original authors wrote and meant — literary context, original language insights, and precise wording.

> **Coming back to this project later?** Start with [RESUME_INSTRUCTIONS.md](./RESUME_INSTRUCTIONS.md). It summarizes the current state, how to resume this conversation with Grok, and the exact next steps for testers + launch.

## What's New (v2.0)

- **Secure by default**: Your xAI API key lives only on the server (never in the browser).
- **Accurate Bible text**: Automatically pulls real verse text from the excellent free public Bible API when you mention a reference.
- **Current model**: Uses `grok-4.3` via the official xAI endpoint.
- All the excellent voice features from v1 preserved and improved (hands-free conversation with accurate Bible ref transcription via cheap xAI STT, premium xAI Grok voices for highest tier, fast local system voices primary, legacy hosted option for manual speak only).

## Quick Start

1. **Get an xAI API key**
   - Go to https://console.grok.com or https://x.ai

2. **Set up the project**
   ```bash
   cd ~/Developer/word-in-context

   # Copy environment file
   cp .env.example .env

   # Add your key
   nano .env     # or use any editor — put your key after XAI_API_KEY=
   ```

3. **Run it**
   ```bash
   npm install
   npm start
   ```

4. Open **http://localhost:8787** in Chrome, Edge, or Safari.

## Features

- Deep original-language and literary context study
- Strict literal translation policy (ESV, NASB, NKJV, LSB, BSB, etc.)
- Voice input + high-quality text-to-speech (including hands-free back-and-forth mode)
- All voices are your browser's built-in system voices (window.speechSynthesis) only. Every installed voice on Mac/iPhone (including premium/enhanced you downloaded via Piper or Spoken Content) appears with no filters. Use the 🔊 buttons in Voice Settings to test them.
- Server-side Bible text injection for accuracy
- Clean, distraction-free interface optimized for long study sessions

## Hands-free Mode (Recommended)

Check the "Hands-free" box at the bottom. The app will:
- Listen after you finish speaking
- Automatically speak the answer
- Listen again when it's done

This creates a natural spoken conversation while studying Scripture.

## Project Structure

```
word-in-context/
├── server.js          # Secure proxy (Grok chat + STT for hands-free + Bible API). All TTS voices are browser window.speechSynthesis only (no server voices).
├── package.json
├── .env.example
├── .gitignore
├── betas.json         # Beta tester signups (from landing form)
├── public/
│   ├── landing.html   # Marketing landing + beta signup form (served at /)
│   └── index.html     # The full chat app UI + voice (served at /app)
└── README.md
```

## Cost control for low-monthly-fee subscriptions (the key to viability)

**Goal**: You (the app owner) pay for Grok + limited TTS out of low monthly subs ($3-8/mo), while giving users a great experience without them needing API keys.

**Defaults are zero-TTS-cost (and zero friction)**:
- All users get excellent free local system voices (Mac "Samantha", "Enhanced", Daniel, Google UK English Male, etc. — modern macOS/iOS neural voices are very good; any purchased voice packs appear automatically in the dropdown).
- Hands-free conversation ALWAYS uses local system voices for speed/reliability (or xAI premium Grok voices when the user explicitly turns on the "Use Premium Grok Voices" toggle for the highest tier).
- The legacy free hosted neural voices (via your own TTS_SERVER_URL env, e.g. the edge-tts Render service) are isolated to manual speak (🔊 button or mic when hands-free is off) and can be completely disabled by simply not setting TTS_SERVER_URL.
- Voice output uses only the device's own system voices (no xAI or server TTS for speech). STT (for hands-free input) and chat use the XAI_API_KEY.

**Full text for auto-speak**:
- Hands-free auto-speak uses the full Grok reply (local: free/unlimited; xAI premium when toggled on).
- /api/tts routes to xAI audio/speech by default (or your legacy TTS_SERVER_URL if set and client asks for it on manual paths).
- No per-user keys or Docker needed for the good stuff.

**Cost for owner**:
- xAI TTS is usage-based (~$15 per 1M chars). Predictable for first 100 users at your estimated 5-10k chars/day/user.
- Local voices = $0.
- Legacy hosted (if you keep the TTS container) is a small fixed cost on Render (~$7-14/mo Hobby) with no per-char billing to you.
- You can shut off the old hosted path entirely by unsetting TTS_SERVER_URL (the UI gracefully falls back; no breakage).

This keeps the app viable for low monthly fee subs while giving the best "talk to Grok about the Bible" experience to paying/highest-tier users.

## Important Notes

- The key in `.env` is loaded only by the Node server.
- The old single-file version (with the key in the browser) has been retired for security reasons.
- Bible text comes from https://bible.helloao.org (free, unlimited, excellent literal translations available).

## Troubleshooting

- **"No XAI_API_KEY"**: Make sure `.env` exists and contains your key, then restart the server.
- Voice not working well? Try Chrome/Edge first (best SpeechRecognition support). On macOS, download additional voices in System Settings → Accessibility → Spoken Content (local voices are free + high quality).
- For the best voices: in Voice Settings (🔊) turn on "Use Premium Grok Voices (xAI powered)" for hands-free + manual. Local system voices are the reliable default (especially for hands-free). Legacy hosted neural (if you run the optional TTS service) is available for manual speak only when TTS_SERVER_URL is configured on the server.
- **Console spam** (e.g. "MaxListenersExceededWarning", "ObjectMultiplex", "orphaned data", "malformed chunk", "The Shared Storage API is deprecated...", "csNotification", "Content Security Policy of your site blocks the use of 'eval' in JavaScript"): These come from browser extensions (most commonly MetaMask / wallet extensions) that inject content scripts into *every* page, including your localhost dev server. They are harmless to the app and have nothing to do with The Word in Context. The app already filters the known noisy strings from console.warn/error/info. For a perfectly clean console during development:
  - Open the app in an Incognito / Private window (most extensions are disabled by default), or
  - Go to `chrome://extensions/` and temporarily disable MetaMask (and any other wallet/ad/privacy extensions) while working on voice features.
  - The source will often show as `contentscript.js:XXXXX` — this confirms it is extension-injected code, not the app.
  - CSP "eval" blocks are typically the extension itself attempting dynamic JS execution in the page context; our code never uses `eval`, `new Function(string)`, or string timers.

---

Built for careful, reverent study of the original text of Scripture.

## Launching as a Subscription SaaS – Getting Testers & Users

**Current implemented state (refined demo + admin + config)**:
- Full Stripe trial (TRIAL_DAYS=7 by default, configurable via env) + separate no-card 14-day tester signup (TESTER_TRIAL_DAYS env) + magic-link login (Resend) + JWT sessions. UI and success pages use the configured values (no hard-coded 3).
- "Try the App" button on landing goes to limited demo: **3 responses** (via `DEMO_LIMIT` env) with banner, disables, strong CTAs to trial. Server supports demo calls + IP throttle.
- New **card-free tester path**: "Sign up for 14-day tester access (email only, no card)" form on landing. Calls `/api/tester-signup` → email-only, 14-day full access (TESTER_TRIAL_DAYS env), magic link, no Stripe/checkout. Access auto-expires. Normal signups still go through Stripe (TRIAL_DAYS=7 default, card collected for post-trial billing).
- `/admin` page: enter `ADMIN_PASSWORD` → full user list + grant/revoke/manual_free toggles (no more curls).
- `/api/config` for dynamic limits.
- All privacy disclaimers, "John" wake word, live SBL Greek + WLC Hebrew, local voices priority, etc. are live.
- Deployed model: Render + Node 22 pin (see .nvmrc + package.json engines).

Update these docs when you change env-driven behavior.

### 1. Getting Beta Testers to Sign Up
- **Landing page first**: The root `/` now serves a beautiful marketing landing page (`public/landing.html`) with pricing, features, and a beta signup form.
- Run locally: `npm start` then visit http://localhost:8787 — people see the landing and can sign up.
- The trial form POSTs to `/api/create-checkout` (real Stripe Checkout with trial_period_days from env). Tester path uses `/api/tester-signup` (no Stripe). No more simple betas.json for the paid path (betas.json may still exist for legacy).
- **Recruitment channels** (from real SaaS experience):
  - Your personal network + church / small group / Bible study friends.
  - Reddit: r/Bible, r/Christianity, r/Reformed, r/BibleStudy (post value-first, not just "try my app").
  - Facebook Groups, Christian Discord/Slack communities.
  - X/Twitter, LinkedIn posts tagging Bible teachers.
  - Product Hunt "beta" or "Show HN" style, Betalist, BetaList.
  - Offer clear incentive: "3 months free + input on features + lifetime discount".
- Be specific: "Spend 10 minutes testing hands-free on a drive and tell me what broke."

### 2. Turning Testers into Paying Subscribers
- After beta: Add real Stripe (see below).
- Use the landing page + email list you collect.
- In-app: "Account" button shows real email + trial status (from /api/me). "Try the App" (demo) for unauth visitors is limited to DEMO_LIMIT responses before forcing the trial CTA. Full access only after successful Stripe trial + magic link login.
- Keep the unique value front and center: **spoken original Greek/Hebrew citations + "John" hands-free + free local voices** = hard to copy cheaply.
- Low price point ($4.99–$6.99/mo) + "free voices forever" makes conversion easy.

### 3. Do You Need a Patent?
**Short answer: No — and it would probably be a waste of money right now.**

- You cannot patent an *idea* ("AI voice Bible study chat"). Patents protect specific novel technical implementations (algorithms, processes), not concepts.
- Software patents are extremely expensive ($15k–$40k+), take 2–4 years, and are hard to enforce (especially after the Alice Supreme Court decision). Most SaaS companies do **not** patent their core product.
- **Better, cheaper, faster protection**:
  - **Copyright** (automatic): Your code, the exact prompts, the UI designs, the landing page copy, the specific way sources are fetched and displayed are all protected the moment you write them. Register with copyright.gov for extra strength (~$45–65).
  - **Trademark** the name + logo ("The Word in Context" + the book icon). Do this early via USPTO or a service like LegalZoom. Prevents others from using a confusingly similar brand.
  - **Trade secrets**: Keep your best system prompts, any custom ranking/grounding logic, and customer data secret. Use NDAs when sharing code with contractors or testers.
  - **Contracts**: Have beta testers sign a simple NDA + feedback agreement. Add strong Terms of Service + Privacy Policy (use Termly or similar generators).
- The real moat is **execution + data network effects + brand** (the specific "John" wake word + live original language grounding + low-cost voice model is hard to replicate perfectly while keeping costs low).
- Focus on shipping fast, getting real users, and building community. Most "copied" apps fail because they miss the details and the trust.

**Recommendation**: Talk to a lawyer who understands software/SaaS (1-hour consult is cheap insurance). File a trademark for the name soon. Copyright your code (you already own it). Don't spend on patents unless you invent a truly novel technical method you want to license.

### 4. Real Subscriptions (Stripe)
1. Sign up at stripe.com (test mode first).
2. Add your publishable + secret keys to `.env`.
3. In the subscribe modal or landing, create a Checkout Session on the server and redirect.
4. Webhooks for subscription status (store in a real DB later: SQLite, Postgres, or Supabase).
5. Gate features in the client (e.g. unlimited messages, always show original sources) based on a `subscribed` flag from your backend.

Example starter (add to server.js later):
```js
const stripe = require('stripe')(process.env.STRIPE_SECRET);
app.post('/api/create-checkout', async (req, res) => {
  const session = await stripe.checkout.sessions.create({...});
  res.json({ url: session.url });
});
```

### 5. Hosting for Testers (Do NOT use Bluehost)
**No, do not use Bluehost.** Bluehost is primarily for PHP/WordPress shared hosting. It has very poor or no native support for Node.js/Express apps like this one. You'll fight deployment, get poor performance, and it won't scale even for beta.

**Recommended cheap & easy options for your current Express + static HTML app (perfect for small beta, $0–$10/mo to start):**

- **Render.com** (top recommendation right now):
  - Free tier for web services (spins down after inactivity, but great for beta).
  - Paid "Starter" ~$7/mo for always-on.
  - GitHub deploy in minutes: Connect repo → New Web Service → Build Command: `npm install`, Start: `npm start`.
  - Set env vars (XAI_API_KEY, PORT=10000, NODE_ENV=production) in dashboard.
  - Auto HTTPS, custom domain easy.
  - Great free tier limits for low-traffic testers.

- **Railway.app**:
  - Very simple Git-based deploys.
  - Free trial credits, then metered (~$5–10 for small usage).
  - Excellent for Node + any DB if you add later (Postgres for real users).
  - One-click templates for Express.

- **Other solid cheap options**:
  - Fly.io (global, cheap, good free tier).
  - DigitalOcean App Platform or $6 Droplet (full control).
  - Vercel (excellent for frontend; deploy backend as serverless functions or pair with Render).

**Deployment steps (Render example):**
1. Push your code to GitHub (public or private).
2. In Render dashboard: New > Web Service > Connect GitHub repo.
3. Root Directory: leave blank (or point if monorepo).
4. Build Command: `npm install`
5. Start Command: `npm start`
6. Add Environment Variables (all required for full SaaS):
   - `XAI_API_KEY` = your xAI key
   - `NODE_ENV=production`
   - `PORT=10000` (Render requires this)
   - `STRIPE_SECRET_KEY` = sk_test_...
   - `STRIPE_WEBHOOK_SECRET` = whsec_test_...
   - `STRIPE_PRICE_ID` = price_...
   - `RESEND_API_KEY` = re_...
   - `JWT_SECRET` = (long random, e.g. openssl rand -base64 48)
   - `ADMIN_PASSWORD` = (your choice, for /admin and /api/admin/login)
   - `TRIAL_DAYS=7` (optional, default 7 — length of normal Stripe trial)
   - `TESTER_TRIAL_DAYS=14` (optional, default 14 — length of card-free tester email-only access)
   - `DEMO_LIMIT=3` (optional, default 3 — controls the "Try the App" limited responses)
   - `RENDER_EXTERNAL_URL` = https://thewordincontext.org (or your current onrender URL while testing on the render domain; update when you switch custom domain DNS)
7. Deploy. Your app will be at something like `https://thewordincontext.org` (or your Render URL during testing)
8. Update landing links and tell testers to use the new URL (not localhost).

**Production prep notes (many already done in current code):**
- `process.env.PORT || 8787` and trust proxy already in server.js
- Lightweight demo IP throttle implemented (no extra deps); full `express-rate-limit` + helmet can be added later for extra safety.
- Full auth + Stripe trial + admin controls live (no simple beta gate needed).
- SQLite (`users.db` + better-sqlite3) is already the persistent store for accounts/trials (good for Render free disk).
- .nvmrc + package.json "engines": {"node":"22.x"} to keep better-sqlite3 happy on Render.
- Domain/custom + Resend verification (critical for magic links to work from your domain): 
  Add the domain in Resend dashboard, add the DNS records it gives you (including resend._domainkey for DKIM, _resend for verification, SPF), verify it, then set the RESEND_API_KEY (the re_ key, separate from the DNS records). See .env.example for full steps. Do this early.
- Add ToS/Privacy (use a generator) + consider a simple public /privacy page.

After deploy, send testers the public URL + instructions: "Visit the landing, sign up for beta, then use the /app link."

### 6. Web App First, Then Mobile (Strongly Recommended)
**Yes — start exclusively with the web app.** 

You already have a great web experience (desktop for deep study + mobile browser). This is the fastest, cheapest way to get real feedback from testers.

**Why web first for this MVP:**
- Instant updates (no App Store review delays).
- Reaches desktop + mobile users immediately (most serious Bible study happens on bigger screens anyway).
- Much lower development cost/time.
- Easier to iterate based on feedback.
- Can make it feel app-like with PWA (add to home screen, offline support later with service workers).

**Mobile plan (Phase 2, after 100+ paying or highly engaged users):**
- Wrap as Progressive Web App (PWA) first — users can "install" from browser.
- Then build native: React Native (or Flutter) for iOS + Android from one codebase.
- Prioritize iOS first if your early users are in US/Western markets (higher willingness to pay for subscriptions).
- Use Capacitor or similar to share web code if you want hybrid.
- Push notifications, better offline Bible caching, and App Store discoverability are the main wins for native.

Don't build native until the web version proves people love it and will pay. Most successful SaaS (even consumer) validate on web first.

### 7. How to Market It (Practical Playbook)
Focus on **value-first content + targeted communities** in the Christian/Bible study space. Your unique hooks (spoken original Greek/Hebrew + "John" hands-free + live verifiable sources + free high-quality local voices) are very marketable.

**Immediate low-cost channels (start here for beta testers):**
- **Reddit** (very high ROI for this niche):
  - Subreddits: r/Bible, r/Christianity, r/Reformed, r/BibleStudy, r/TrueChristian, r/OpenChristian, r/AcademicBiblical.
  - Strategy: 80-90% value (answer questions about Greek/Hebrew words, context, study methods). 10-20% soft promo: "I built a free web tool that pulls live SBL Greek + WLC Hebrew and lets you speak with Grok grounded in the text — here's the link if anyone wants to beta test."
  - Post your own study insights generated by the app.
- **Facebook Groups**: Search "Bible study", "Greek Hebrew Bible", "original languages", church small group groups. Many are active.
- **X/Twitter + Instagram**: Post short clips of the voice speaking Greek with translation. Tag Bible teachers, @BibleProject, etc.
- **Church / personal network**: Email or message 20-30 people you know in Bible studies/pastors/seminary students. Offer personal onboarding call.
- **Product Hunt**: Launch there when you have 50+ beta users and some testimonials. "Voice-first Bible study with live Greek & Hebrew sources".
- **Content marketing**: Write 1-2 blog posts or YouTube shorts per week on "How context changes the meaning of [word]" using your app. Drive to landing page.

**Incentives that work:**
- 3 months free + "Founding Tester" badge + lifetime 20% off.
- Input on features.
- Private Discord/Slack for testers.

**Funnel:**
1. Landing page (you have this) → Beta signup form (collects to betas.json + email).
2. Email sequence: Welcome + "how to use" video + "join our tester Discord".
3. In-app: "Upgrade/Beta" button for activation.
4. After good feedback: Convert to paid via Stripe.

**Metrics to track early:** Signups, time spent in app, % who use hands-free + voice, % who engage with Greek/Hebrew sources.

### 8. NDAs for Testers
**Yes, you should use NDAs (or at least a simple feedback agreement) for early testers**, especially the first 20-50.

Why:
- Protects your unique system prompts, exact grounding logic, any custom features.
- Sets expectations around feedback and confidentiality.
- Professional signal.

**Practical advice:**
- For general beta users (the landing form): A strong **Terms of Service + Privacy Policy** is the minimum (generate free at Termly.co or similar). State that chats go through Grok proxy, data is used to improve the product, etc.
- For dedicated testers (people you email personally or the first wave): Have them sign a simple 1-page NDA + "Beta Tester Agreement" before giving access.
  - Free templates: Search "simple NDA template PDF" or use Rocket Lawyer / LegalZoom free versions. Key clauses: Confidential info (prompts, unreleased features), no reverse engineering, feedback is owned by you, no public disclosure without permission.
- When you move to public paid: Drop strict NDAs, rely on ToS.

**Action item**: Before sending the deployed link, create a Google Form or Typeform that includes "I agree to the NDA" + link to a PDF. Or just email a simple agreement and have them reply "I agree".

You can find standard templates easily. If budget allows, have a lawyer review the first version ($200-400 one-time is worth it).

See the updated sections above for more. The code changes below prepare you for easy deploy.

### Next Immediate Actions
1. Push code to GitHub.
2. Deploy to Render (follow steps above) — should take <30 min first time.
3. Update the landing page URL in your mind / share the new public URL.
4. Start recruiting: Send personal messages to 10 people today + make one Reddit post with value.
5. Set up Stripe test account and basic ToS/Privacy.
6. When you have 20+ signups, send them the deployed link + NDA.

This is very doable as a solo founder. Web-first + targeted faith communities is the smartest path. You've already built something special with the original languages + voice experience.

Let me know when the deploy is live or if you want me to add code for basic beta auth gate, PWA manifest, rate limiting, or Stripe skeleton next. Go get those testers!
