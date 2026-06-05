# How to Resume This Conversation and Project

**Current Date Context:** We're in the middle of turning "The Word in Context" into a shippable SaaS product.

## 1. Coming Back to This Chat with Grok (After Closing the Terminal)
Grok **automatically persists** every conversation to disk as a "session". You do **not** lose anything when you close the terminal.

### Quickest ways to resume:

**Best option (one command):**
```bash
cd ~/Developer/word-in-context
grok -c
# or
grok --continue
```
This directly continues the **most recent session** for this exact directory.

**From the welcome screen:**
```bash
cd ~/Developer/word-in-context
grok
```
Grok will show a list of recent sessions for the current working directory on the welcome screen. Just select the one (it shows a summary like the current topic).

**Inside the TUI (if already running):**
Type `/load` or `/resume` to open the session picker.

**List sessions from CLI:**
```bash
grok sessions list
```
Then resume a specific one:
```bash
grok --resume <session-id>
```

**Critical:** You **must** run the command from the project directory (or use `--cwd`):
```bash
cd ~/Developer/word-in-context
grok -c
```
Sessions are scoped to the working directory.

The full conversation history, all tool results, file edits, TODO state, etc. are restored exactly.

(Full details: `~/.grok/docs/user-guide/17-sessions.md`)

## 2. Project State Right Now (latest refinements)
- **Tester access (new, card-free)**: Separate "Sign up for 14-day tester access (email only, no card)" form on landing. Calls `/api/tester-signup` → creates user with `status=trialing`, `trial_end=+14d` (TESTER_TRIAL_DAYS env), sends magic login link. Full unlimited access during the period, then auto-expires. No Stripe at all for these users. Normal paid path remains Stripe with TRIAL_DAYS (default 7, card for after trial).
- **"Try the App" limited demo**: Landing "Try the App" / Free plan buttons go to `/app?demo=1`. Unauthenticated users get **exactly 3 responses** (configurable via `DEMO_LIMIT` env). 
  - Prominent yellow/red demo banner + count, disables input/mic/send after limit, in-chat + modal CTAs to the trial form.
  - Full quality experience during the 3 (voice "John", hands-free, live Greek/Hebrew sources).
  - Server allows demo calls (no JWT) but has IP-based throttle + client daily reset.
- **Configurable trial**: `TRIAL_DAYS` env (default 7 for normal Stripe path). `TESTER_TRIAL_DAYS` (default 14) for the no-card tester path. Used in DB + Stripe. UI texts are dynamic where possible.
- **Admin UI**: Visit `/admin` (or yourdomain/admin). Enter `ADMIN_PASSWORD`. Lists all users, one-click grant/revoke access, "make free forever" (manual_free), remove free. Uses the existing `/api/admin/*` routes. Much better than curls.
- **/api/config**: Public endpoint returning `{demoLimit, trialDays, testerTrialDays}` so UI and admin reflect current env.
- **Landing + app**: All Try buttons, pricing, texts updated for the 3-response demo limit. "The Word in Context" branding everywhere. Wake word default "John".
- **Auth/Stripe still full**: Configurable trial (default 7 days via TRIAL_DAYS env) via Stripe Checkout for normal (card for after), plus no-card 14-day tester signup via email. Magic link login via Resend. You control everything via admin or DB.
- **Files**: server.js (main logic + new /admin + /api/config + throttle), public/landing.html, public/index.html (demo UX + dynamic limit).

**Pro tip for next session**: "ok let doit" or "continue with admin UI + docs" etc. will pick this up.
- **Main chat app**: `public/index.html` — served at `http://localhost:8787/app`
  - Full features: Grok chat, voice (local + ElevenLabs BYOK), hands-free with customizable wake word ("John" default, can turn off or change name), live sources with Greek (SBL etc.) + Hebrew (WLC), per-message sources UI, etc.
- **Server**: `server.js`
  - Routes: `/` = landing, `/app` = chat
  - `/api/beta-signup` endpoint (saves to `betas.json`)
  - `/api/chat`, TTS, voices, Bible grounding with originals
  - Production-ready comments added (PORT from env, rate limit notes)
- **Testers list**: `betas.json` (auto-created on first signup)
- **Docs**: 
  - `README.md` has a massive new "Launching as a Subscription SaaS" section at the bottom with:
    - Hosting recommendations (Render/Railway — **NOT Bluehost**)
    - Detailed deployment steps
    - Marketing playbook (Reddit, FB groups, content, Product Hunt)
    - Web-first then mobile strategy
    - NDA guidance for testers
    - Real subscriptions (Stripe) notes
  - This `RESUME_INSTRUCTIONS.md` (you're reading it)

**Key files to know:**
- `public/landing.html` — your public face for signups
- `README.md` — the full current bible for launch
- `server.js` + `public/index.html` — the product

## 3. Immediate Next Steps (from last session)
1. **Push to GitHub** (if not already).
2. **Deploy publicly** (don't use localhost for real testers):
   - Best: Render.com (free tier good for beta) or Railway.app
   - Full step-by-step is in README.md → "Hosting for Testers" section
   - After deploy, your testers will use `https://your-app.onrender.com` (landing at root, chat at /app)
3. **Recruit testers**:
   - Personal network + church/Bible study friends first (easiest wins)
   - Reddit value posts (r/Bible, r/Christianity, etc.)
   - Use the landing page form
4. **For testers**:
   - Send them the public URL
   - Early ones: Ask them to sign a simple NDA (templates in README guidance)
   - They sign up on landing → you see them in `betas.json`
   - In-app "Upgrade / Beta" button lets them activate (currently local sim; replace with real auth/Stripe later)
5. **Marketing**:
   - Value-first content in Christian communities
   - Full playbook in README
6. **Later**:
   - Add real Stripe
   - Move to real DB (from localStorage + betas.json)
   - Add proper user accounts
   - Web first → then React Native / Flutter for iOS/Android

## 4. Quick Commands to Get Back Into the Code
```bash
cd ~/Developer/word-in-context

# Run locally (landing at http://localhost:8787 , app at /app)
npm start

# Check current testers
cat betas.json

# View the full launch plan
cat README.md | tail -100   # or open in editor and jump to the "Launching as a Subscription SaaS" section

# Edit the landing page
# (use your editor on public/landing.html)

# Edit the main app
# public/index.html  (chat UI) + server.js
```

## 5. How to Ask Me to Continue Specific Work
Just say things like:
- "Let's deploy this to Render now — walk me through the steps for the current code"
- "Update the landing page with X feature"
- "Add real Stripe checkout"
- "Help me write a Reddit post for beta testers"
- "Create a simple NDA template text"
- "Add basic user auth so beta users can log in"
- "Prepare for mobile apps (React Native skeleton?)"

I have the full context and can inspect/edit files directly with tools.

## 6. Current Server State
- The dev server was last running on port 8787.
- Landing page is the public entry point now (good for sharing with testers).
- All recent features (custom wake word in Voice Settings, Greek/Hebrew context explanations in Sources modal, beta signup, subscription UI, etc.) are in place.

**Pro tip:** The README.md is now your single source of truth for "what next?" — it was heavily expanded in our last session with exactly the answers to hosting, marketing, NDAs, web-vs-mobile, etc.

You're in a great spot. When you come back, just reference this project and we'll pick up exactly where we left off (probably with deployment).

If the Grok interface gives you a new session, paste a short summary like: "We're building The Word in Context Bible voice app. Last we were preparing for beta testers: landing page ready, need to deploy and market."

See you soon! 🚀

— Grok (your coding + launch partner)