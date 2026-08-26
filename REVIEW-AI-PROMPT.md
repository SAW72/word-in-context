# Review: John’s AI prompt and wiring

Investigation only. **No production prompt or chat behavior was changed.**

Product facts treated as truth:

- Voice-first Bible study; wake word default `"John"`
- Live Greek NT (SBLGNT, Byzantine, TR) and Hebrew OT (Westminster Leningrad Codex) from `bible.helloao.org` — nothing hardcoded
- Disclaimer: AI study tool, not a pastor, not divine guidance; test every answer against Scripture
- Chats stay on device; server only proxies Grok
- Recent live answers (John 1:14 ὁ λόγος σὰρξ ἐγένετο; Psalm 136 hesed vs ahavah) looked solid

---

## 1. Where the AI prompt lives

**Authoritative prompt:** `server.js`, constant `SYSTEM_PROMPT` (starts ~line 676).

It is **not** a separate template file. Assembly happens only in `POST /api/chat`:

```text
system = SYSTEM_PROMPT
       + USER PREFERENCE (default English translation from Settings)
       + bibleContext   (live helloao blocks and/or topical / word-study notes)
```

Then:

```js
const apiMessages = [
  { role: 'system', content: SYSTEM_PROMPT + userTransPref + bibleContext },
  ...messages.filter(m => m.role !== 'system')
];
const rawReply = await callXaiChat(apiMessages);
const reply = normalizeWordPhrasing(rawReply);
```

`callXaiChat` (`server.js` ~599) posts to `https://api.x.ai/v1/chat/completions` with `XAI_MODEL` (default `grok-4.3`), temperature `0.55`, `max_tokens` `1600`, then falls back to `grok-3` / `grok-2-latest`. The xAI key is read from `XAI_API_KEY` on the server only.

**Dead / unused copy:** `public/index.html` ~2434 defines a shorter `SYSTEM_PROMPT`. The comment says the server prompt is authoritative. `sendToGrok` sends only `{ messages, defaultTranslation }` — **the client prompt is never sent.** It is already drifting from the server (weaker translation list, no disclaimer, no “John” identity, no application-to-today rules).

**Other prompts (not John chat):**

| Location | Role |
|---|---|
| `content/generator.js` | Separate social-post prompt for Buffer/Reels. Not John’s study prompt. |
| `public/john-popup.js` `buildApiUserMessage()` | Wraps landing/help/sources teaser **user** text; still uses the same server `SYSTEM_PROMPT`. |
| Welcome copy in `public/index.html` `showWelcomeMessage()` | Hardcoded first bubble. Not sent to Grok. This is where John actually introduces himself. |

### How grounding is built (`server.js` ~2859–3049)

1. `extractRefs(lastUserContent)` — regex requires `Book 1:2` or `Book 1:2-10` (colon + verse). Chapter-only (`Psalm 136`, `Galatians 6`, `John 1`) does **not** match.
2. `extractThematicRefs` — hardcoded extra refs for a few topics (Paul “last apostle”, marriage/sex, divorce/remarriage).
3. Follow-up: if the current turn has no refs and looks like a passage/word-study follow-up, pull refs from the last 8 messages.
4. Cap: 3 refs (narrow verse focus) or 6; fetch at most 2 or 4 of those.
5. For each fetched ref: English (`defaultTranslation` or BSB fallback) + `grc_sbl` + `hbo_wlc`. Incompatible book/language returns null (Hebrew on NT, etc.).
6. Blocks labeled `[ACCURATE BIBLE TEXT]`, `[ORIGINAL GREEK TEXT]`, `[ORIGINAL HEBREW TEXT]`, plus a `GROUNDING NOTE`.
7. After Grok replies, `extractRefs(reply)` fetches more live text for the Sources panel only — **not** fed back into the model.

`public/data/study-lexicon.json` is **not** part of the Grok prompt. It is a small client glossary for Library / reader word chips. John’s Greek/Hebrew for chat comes from helloao + the model.

---

## 2. What the live prompt currently instructs

Quoted from `SYSTEM_PROMPT` in `server.js`.

**Identity**

> You are an expert, reverent guide for studying the Hebrew, Aramaic, and Greek Scriptures… You are the AI assistant inside the "Word in Context" Bible app.

The prompt **never names the assistant “John.”** Wake-word “John” is client-only (`public/index.html`). Self-intro (“not the apostle John, not a pastor”) lives only in the welcome bubble.

**Translation policy**

> Use only the Berean Standard Bible (BSB) by default. Quote exclusively from… BSB, KJV, NET, Darby, ASV, YLT, or WEB. Never quote NASB, ESV, NKJV, LSB, NIV, NLT, or The Message. When [ACCURATE BIBLE TEXT] grounding is provided… quote that exact wording verbatim…

**Conversation scope**

> Each new user question sets the topic… You are never limited to only the verses in grounding blocks… Grounding blocks are supplementary anchors… not a cage.

**Topical requests**

> …actively identify and present **every relevant biblical passage** across the Old and New Testaments.

**Context / authorship**

> Every doctrinal claim must still be grounded in what The Word explicitly says. Interpret Scripture with Scripture first.

Also required: author, audience, relative composition order; default Gospel order Matthew → Mark → Luke → John unless the user asks for Markan priority.

**Primary witness / study order**

1. Primary witness (verbatim, allowed English)
2. Author, audience, composition setting
3. Original language of **that same verse**
4. Immediate same-chapter context
5. Cross-references last

**Do / don’t (core)**

- Do not invent doctrines from outside Scripture; do use author/date/order as interpretive context.
- Do not weigh or count passages; do not rank by frequency.
- Do not skip the verse that asserts the claim (long examples: Mark 16:17–18 vs Acts 1:21–22; 1 Cor 15:8 vs “last apostle”).
- Application-to-today: answer plainly first; speaker intent; Greek/Hebrew; OT→NT when relevant; say when application is unstated.
- Large special-case blocks: divorce/remarriage; signs/wonders vs apostles; “what Paul said.”
- Wording: always “The Word states/indicates/says…” — never “the text states.” Enforced again by `normalizeWordPhrasing()`.
- Content safety: refuse porn/erotica/harm; **do** answer biblical sexual-ethics study.
- Refuse requests “clearly unrelated” to Scripture study — in tension with the APP INSTRUCTOR ROLE.

**Original languages**

> For every verse you explain… anchor the analysis in the Greek manuscript (NT) or Hebrew manuscript (OT)… When [ORIGINAL GREEK TEXT] or [ORIGINAL HEBREW TEXT] grounding is provided… use that wording… **Never speak or pronounce Hebrew or Greek words aloud unless requested.**

**Citations (this is weaker than the product/UI claim)**

> Whenever you reference a verse, immediately follow it with the translation name, for example: "according to the Berean Standard Bible." **Mention the original language source only once per response, such as "in the Hebrew manuscript" or "in the Greek manuscript."**

The prompt does **not** require “SBL Greek New Testament” or “Westminster Leningrad Codex.” The Sources modal (`public/index.html` ~2251, 2280–2285) claims the opposite.

**Disclaimer**

Full product disclaimer is **in** the prompt under `APP IDENTITY & DISCLAIMER`:

> The Word in Context is an AI study tool… All explanations… are generated by artificial intelligence. The AI is not a pastor, priest, or spiritual authority. Every response should be tested against the Bible itself. "Test everything; hold fast what is good" (1 Thessalonians 5:21)… not intended to replace personal prayer… not affiliated with any denomination…

Instruction is only: **“You must always remain consistent with this disclaimer.”** It does not say to speak or print a short disclaimer in each reply. The UI already shows a banner: “AI study tool — not a pastor, not divine guidance.”

**Voice**

> Speak all responses aloud naturally as if reading to the user. Do not use commands or formatting in your spoken replies.

There is no separate spoken vs written channel. The same `reply` string is shown and passed to `speak()` → `cleanTextForSpeech()`, which strips markdown but **not** Greek/Hebrew script.

**App instructor (very thin)**

Knows: change default translation, pick voices, wake-word / hands-free, Sources panel, save/clear chats. Does **not** state: default wake word “John”; chats stay on-device; server only proxies Grok; disclaimer one-liner; Library vs Chat; Byzantine/TR availability.

---

## 3–4. Recommended changes (ranked)

### Must-fix

These are mismatches with stated product truth, or code that can silently drop live text.

#### M1. Citation rule is too vague — model is told *not* to name SBL/WLC

**Why:** Product and Sources UI say every original-language cite names the edition. The live prompt says mention the source **once**, as “the Greek manuscript” / “the Hebrew manuscript.” That lets John sound sourced while inventing or omitting the edition. Recent John 1:14 / Psalm 136 answers can look solid from Grok’s training even when the spoken cite is generic.

**File:** `server.js` `SYSTEM_PROMPT` (Citations) + Sources modal copy.

**Proposed prompt wording:**

```text
Citations
Whenever you quote a verse, name the English translation immediately
(e.g. "according to the Berean Standard Bible").
When you use original-language wording:
- NT Greek: name the edition you were given in grounding
  (SBL Greek New Testament by default; Byzantine or Textus Receptus only
  if that block is present or the user asked for it).
- OT Hebrew: name Westminster Leningrad Codex.
Do not invent an edition. If no [ORIGINAL … TEXT] block is present,
say you are discussing the wording from memory and ask the user to
open Sources — do not present a guessed Greek/Hebrew string as live text.
Prefer transliteration in the spoken sentence; keep untransliterated
script only when the user asked to hear or see the letters.
```

#### M2. Chapter-only and common abbreviations never ground

**Why:** Sources modal examples include “Galatians 6”. Psalm 136 (the hesed example) is usually asked as a **chapter**. `extractRefs` requires `chapter:verse`. Those questions go to Grok **ungrounded**. `fetchBiblePassage` *can* parse `Psalm 136` but then defaults missing verses to **1–1**, so even a future chapter extract would return only verse 1.

Also: `1 Cor 15:8` → book key `"1 cor"` is **not** in `bookMap` → fallback `slice(0, 3)` → `"1 C"` → failed fetch. `Song of Solomon 2:1` extracts as `Solomon 2:1` → `"SOL"`. `1 Thess`, `2 Tim`, `Song of Songs` similarly miss.

**File:** `server.js` `extractRefs`, `fetchBiblePassage` / `bookMap`.

**Proposed code change (sketch, do not ship in this review):**

```js
// extractRefs: also match chapter-only and ranges
/\b((?:1|2|3)\s?[A-Za-z]+|[A-Za-z]+(?:\s+of\s+[A-Za-z]+)?)\s+\d+(?::\d+(?:-\d+)?)?\b/g

// fetchBiblePassage: if no verse, fetch the whole chapter (or 1–N), not v1 only
const wholeChapter = !match[3];
// verseStart/End = whole chapter when wholeChapter

// bookMap aliases
'1 cor': '1CO', '2 cor': '2CO', '1 thess': '1TH', '2 tim': '2TI',
'song of songs': 'SNG', 'canticles': 'SNG', 'solomon': 'SNG', // only if extracted that way
```

Keep a denylist so “John 14” from prose is a ref but “chapter 3” / “verse 2” are not.

#### M3. Byzantine and TR are advertised, never fetched for chat

**Why:** Product fact and Sources/attributions say live SBL + Byzantine + TR. Chat only requests `grc_sbl` and `hbo_wlc`. `transDisplayNames` includes `grc_byz` / `grc_gtr` but nothing calls `fetchBiblePassage(ref, 'grc_byz')`. If the user asks “what does the TR say?”, John will guess.

**File:** `server.js` fetch loop (~3027–3033); Sources modal list.

**Proposed code change:**

```js
const grc = await fetchBiblePassage(ref, 'grc_sbl');
if (grc) fetchedPassages.push(grc);
if (/\b(byzantine|majority text|textus receptus|\bTR\b)\b/i.test(lastUserContent)) {
  for (const id of ['grc_byz', 'grc_gtr']) {
    const extra = await fetchBiblePassage(ref, id);
    if (extra) fetchedPassages.push(extra);
  }
}
```

Prompt add: “Only cite Byzantine or TR when a grounding block for that edition is present or the user named it.”

#### M4. Pre-LLM adult filter blocks legitimate Scripture study

**Why:** `getBlockedContentReason` treats `\bnaked\b` (and `prostitut`) as adult content and returns 400 **before** Grok. “Why were Adam and Eve naked?” / “Rahab the prostitute” never reach the prompt’s “DO answer Scripture study on…” rules.

**File:** `server.js` ~617–623.

**Proposed code change:** drop `naked` and `prostitut` from the hard block, or require a second adult token (`porn`, `xxx`, `onlyfans`, …). Keep the prompt’s porn/erotica refuse.

#### M5. Spoken Greek/Hebrew vs TTS (prompt vs product vs code)

**Why:** Voice-first. Prompt: never pronounce Hebrew/Greek unless requested. Sources modal: “you hear the original Greek/Hebrew every time.” Same `reply` is spoken. `cleanTextForSpeech` does not strip `\u0370–\u03FF` / `\u0590–\u05FF`. Browser TTS will mangle ὁ λόγος / חסד unless the user asked for it.

**Files:** `server.js` Original Languages + voice closer; `public/index.html` `cleanTextForSpeech`; Sources modal.

**Proposed split:**

Prompt:

```text
Write for the ear first. Put Greek/Hebrew letters in parentheses after a
transliteration (e.g. "ho logos (ὁ λόγος)"). Do not read the letters
aloud unless the user asked you to pronounce them.
```

Code (TTS only):

```js
.replace(/[\u0370-\u03FF\u1F00-\u1FFF\u0590-\u05FF]+/g, '')
```

Update the Sources modal: spoken cite = English translation + edition name + **transliteration**; letters are on screen / in Sources.

#### M6. John is not instructed as “John”; instructor facts are incomplete

**Why:** Users address “John.” Welcome bubble has the right identity and privacy line. The model never sees that. App-how-to questions rely on a 6-line instructor stub, then “refuse unrelated.” Risk: John denies being John, or invents how wake word / storage / keys work.

**File:** `server.js` identity + `APP INSTRUCTOR ROLE`.

**Proposed wording (add at top, keep welcome as UI-only):**

```text
You are John, the in-app AI Bible-study assistant for The Word in Context.
You are not the apostle John, not a pastor, and not divine guidance.
Wake word default is "John" (user-changeable in Settings).
Chats stay in the user's browser; this server only proxies Grok and
fetches public bible.helloao.org text. Never claim chats are stored on
the server. Never mention API keys or hosting internals.
On the first turn of a new chat, you may give a one-sentence disclaimer;
do not repeat a long disclaimer every reply — the app already shows one.
```

---

### Should-fix

#### S1. Delete or sync the unused client `SYSTEM_PROMPT`

**Why:** Two prompts will diverge (already have). A future “send system from client” change would silently weaken John.

**File:** `public/index.html` ~2434.

**Change:** delete the constant; keep a one-line comment pointing at `server.js`.

#### S2. Prompt is a patch-log; special cases crowd the durable rules

**Why:** Divorce, Mark 16, 1 Cor 15:8–9, “Paul last” are long. They help those exact fights and steal attention from ordinary word study (the cases that already looked solid). `extractThematicRefs` + `expandNearbyContextRefs` hardcode the same verses — routing is hardcoded even though **text** is live.

**File:** `server.js` `SYSTEM_PROMPT` + `extractThematicRefs`.

**Change:** keep 5–7 durable rules (primary witness, no cherry-pick, named-speaker, original language, application-to-today, wording, disclaimer). Move the three case studies to a short “examples” appendix or delete once M1–M2 grounding is reliable. Keep thematic ref **fetch** as code, not as a second copy of the sermon in the prompt.

#### S3. “Every relevant passage” is unbounded and fights other rules

**Why:** Topical note says present every relevant OT/NT passage; another rule says never weigh/count; `max_tokens` is 1600. John will either ramble, truncate mid-cite, or invent refs that only get live-checked **after** speech.

**File:** `SYSTEM_PROMPT` Topical + `bibleContext` `TOPICAL REQUEST`.

**Proposed wording:**

```text
For topical requests, give a focused set (about 4–8 primary witnesses)
across OT and NT when both speak. Quote each from an allowed translation.
Do not claim the list is exhaustive. After the reply, Sources will show
live text for refs you named — only name refs you actually quoted.
```

#### S4. No check that spoken English matches the grounding block

**Why:** Grounding says “quote verbatim.” Nothing compares `reply` quotes to `[ACCURATE BIBLE TEXT]`. Hallucinated English can sit next to a Sources panel with the real verse.

**File:** `server.js` after `callXaiChat`.

**Change:** if a fetched English passage exists and the reply’s quote for that ref differs beyond punctuation, append a Sources-only warning or a short system reminder next turn. Do not silently rewrite the spoken sentence without a product decision.

#### S5. Instructor vs “refuse unrelated”; client lie about chapter inference

**Why:** Prompt refuses non-Scripture requests but also says answer app-how-to. Client comment (`index.html` ~6632) claims the server “infers the next chapter from recent refs.” **That server logic does not exist.** `normalizeBibleTranscript` maps “John too/as well/next” → **John 2**, which can send the wrong book.

**Files:** `server.js` Content Safety last bullet; `public/index.html` `normalizeBibleTranscript`.

**Change:** “Refuse only non-study harm/porn/off-topic; app usage is always in scope.” Remove or implement chapter inference; stop rewriting “too/as well” to John 2.

#### S6. Health and error strings leak ops detail (not the key, but enough)

**Why:** Key never goes to the browser (good). `GET /api/health` returns `xaiKeyLength`. `formatXaiError` tells users “The XAI_API_KEY in Render may be missing…”. Landing/help John could repeat that if asked.

**Files:** `server.js` `formatXaiError`, `/api/health`.

**Change:** health: `hasXaiKey: boolean` only. User errors: “AI service is temporarily unavailable.” Prompt: “Never mention API keys, Render, or model fallback names.”

#### S7. Word-study follow-up detector is too broad

**Why:** `isWordStudyFollowUp` matches `soul|spirit|dividing|divide|…` with no new ref, then re-grounds the **previous** passage. “Spirit” in a new topical question can cage John to the last verse.

**File:** `server.js` `isWordStudyFollowUp`.

**Change:** require an original-language cue (`greek|hebrew|transliterat|word study|what does X mean in`) and drop the bare `soul|spirit|divide` list.

---

### Nice-to-have

#### N1. Move `SYSTEM_PROMPT` to `prompts/john-system.txt`

Easier review, no behavior change if loaded as the same string.

#### N2. Separate written vs spoken replies

Optional `spoken` field: transliteration only. Bigger product change; M5 is the minimum.

#### N3. Fetch Aramaic when the passage is Aramaic

Prompt mentions Aramaic; helloao path never fetches an Aramaic edition (Daniel 2–7, Ezra 4–7). Say so, or add the helloao id if one exists.

#### N4. Align `content/generator.js` social prompt

It already says “Do NOT invent exact Greek/Hebrew spellings if unsure.” John’s study prompt should say the same (covered in M1).

#### N5. Library lexicon vs John

`study-lexicon.json` has `חסד` → chesed / “steadfast love.” John does not see it. Fine if chat stays live-text-only; do not start injecting the lexicon into Grok or you will have **hardcoded** glosses.

#### N6. Temperature / tokens

`0.55` / `1600` is a bit loose for verbatim quotes. Consider `0.3` and `2048` after S3 so topical answers finish.

#### N7. Welcome bubble vs prompt

Keep the welcome as the spoken intro. After M6, trim the welcome so John and the UI do not give two different origin stories.

---

## 5. Bugs and risk list

| Issue | Severity | Where |
|---|---|---|
| Client `SYSTEM_PROMPT` unused and already drifted | Should | `public/index.html` |
| `extractRefs` misses chapter-only (`Psalm 136`, `Galatians 6`) | Must | `server.js` |
| Chapter parse defaults to **verse 1 only** | Must | `fetchBiblePassage` |
| `1 Cor`, `1 Thess`, `Song of Solomon` often fail `bookMap` | Must | `bookMap` + regex |
| Byzantine / TR never fetched in `/api/chat` | Must | fetch loop |
| Citations say “Greek/Hebrew manuscript” not edition names | Must | `SYSTEM_PROMPT` |
| Sources modal over-claims (auto-pull Byz/TR; hear Greek every time; “nothing memorized”) | Must | `index.html` sources modal |
| “Nothing hardcoded” is true for **verse text**, false for **which** verses get fetched (Paul/divorce/sex lists) | Should | `extractThematicRefs` |
| `naked` / `prostitut` hard-block before LLM | Must | `getBlockedContentReason` |
| Same reply spoken; Greek/Hebrew not stripped for TTS | Must | `cleanTextForSpeech` |
| Prompt never says “You are John” / on-device chats / proxy-only | Must | `SYSTEM_PROMPT` |
| Disclaimer in prompt but “remain consistent,” not “say this once” | Should | identity block |
| No quote-vs-grounding verification → hallucinated English possible | Should | post-`callXaiChat` |
| `/api/health` `xaiKeyLength`; errors name `XAI_API_KEY` / Render | Should | `server.js` |
| Client comment: server infers next chapter — **does not exist** | Should | `index.html` |
| `"John too"` → `John 2` | Should | `normalizeBibleTranscript` |
| `/api/stt` disabled; client still has xAI STT comments/paths | Nice | `server.js`, `index.html` |
| `isWordStudyFollowUp` too broad | Should | `server.js` |
| `max_tokens` 1600 vs “every relevant passage” | Should | `callXaiChatOnce` |
| Aramaic promised, never fetched | Nice | prompt vs fetch |
| Landing/help/sources teasers share the same system prompt (good) | — | `john-popup.js` → `/api/chat` |
| Keys: not in repo; `.env.example` is a placeholder; key not sent to browser | OK | `getXaiApiKey` |
| Chats: client strips `sources` before POST; stored in `localStorage` only | OK | `sendToGrok` |
| `normalizeWordPhrasing` is a useful safety net for “the text states” | OK | `server.js` |
| Welcome + UI banner already carry the product disclaimer | OK | `index.html` |

**What is working (do not “fix” away):**

- Live BSB (or user translation) + SBLGNT + WLC **when a `Book C:V` ref is detected** — this is why John 1:14 can look solid.
- Server-only xAI proxy; client never gets the key.
- Post-reply source scan for the Sources panel.
- Disclaimer text in the prompt **and** a visible UI banner.
- Follow-up / word-study re-use of prior refs when the user does not repeat them.
- Wording post-process for “The Word states.”

**Likely explanation of the two “solid” live answers:** John 1:14 is a verse-form ref → English + SBL Greek injected. Psalm 136 as a chapter name often **skips** grounding; a good hesed vs ahavah answer is probably Grok knowledge, not WLC text in the prompt. Do not treat that as proof the Hebrew path is reliable.

---

## Suggested edit order (when you choose to implement)

1. M2 + M3 (actually fetch the text the product promises, including chapter asks and optional Byz/TR).
2. M1 + M5 + M6 (prompt: name editions, voice/transliteration, identity/disclaimer/privacy).
3. M4 (stop blocking Genesis / Rahab-type questions).
4. S1, S3, S5, S6, S7 (drift, topical bound, false comments, health leak, follow-up detector).
5. S2 / N1 (prompt slim + file extract) last, so you are not rewriting a moving target.

Do not deploy prompt-only changes without M2: a stricter “never invent Greek” rule with empty grounding will make chapter-level study **worse** until refs actually resolve.
