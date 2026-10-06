    // ====================== SUPPRESS EXTENSION NOISE ======================
    // These warnings come from browser extensions (especially MetaMask and other
    // wallet extensions) that inject content scripts (contentscript.js, csNotification,
    // etc.) into every page, including localhost. Common ones:
    //   - MaxListenersExceededWarning / ObjectMultiplex / orphaned / malformed chunk
    //   - "The Shared Storage API is deprecated..." (Chrome deprecation for extension storage features)
    //   - "Content Security Policy of your site blocks the use of 'eval' in JavaScript"
    //     (extensions trying dynamic code execution; harmless, not our code)
    //   - Various CSP / no-speech / csNotification spam
    // They are completely harmless to this app. We filter at the console level so
    // your dev console stays usable. For a perfectly clean console, use Incognito
    // (extensions disabled) or disable the offending extension(s) during development.
    (function suppressExtensionConsoleSpam() {
      try {
        const originalWarn = console.warn.bind(console);
        const originalError = console.error.bind(console);
        const originalInfo = console.info ? console.info.bind(console) : null;

        const noisy = [
          'MaxListenersExceededWarning',
          'ObjectMultiplex',
          'orphaned data for stream',
          'malformed chunk without name',
          'Possible EventEmitter memory leak',
          'Shared Storage API is deprecated',
          'Shared Storage',
          'csNotification',
          'Content Security Policy of your site blocks the use of',
          "blocks the use of 'eval'",
          'unsafe-eval',
          'Refused to evaluate'
        ];

        function isNoisy(args) {
          const str = args.map(a => {
            try { return typeof a === 'object' ? JSON.stringify(a) : String(a); }
            catch { return String(a); }
          }).join(' ');
          return noisy.some(p => str.includes(p));
        }

        console.warn = function(...args) {
          if (isNoisy(args)) return;
          originalWarn(...args);
        };

        console.error = function(...args) {
          if (isNoisy(args)) return;
          originalError(...args);
        };

        if (originalInfo) {
          console.info = function(...args) {
            if (isNoisy(args)) return;
            originalInfo(...args);
          };
        }
      } catch (e) { /* never break the app over console filtering */ }
    })();

    // ====================== CONFIG ======================
    // John's instructions live only in server.js (SYSTEM_PROMPT). Do not add a client copy.

    // ====================== STATE ======================
    const messagesContainer = document.getElementById('messages');
    const userInput = document.getElementById('user-input');
    const sendBtn = document.getElementById('send-btn');
    const micBtn = document.getElementById('mic-btn');
    const stopBtn = document.getElementById('stop-btn');
    const voiceBtn = document.getElementById('voice-btn');
    const sourcesBtn = document.getElementById('sources-btn');

    let conversation = []; // messages sent to backend (without system)
    let recognition = null;
    let isListening = false;
    let startingRecognition = false; // prevents re-entrant start() calls that cause "already started" InvalidStateError
    let currentUtterance = null;
    let speechQueue = [];
    let speechQueueIndex = 0;
    let speechKeepAliveTimer = null;

    // Audio capture for cheap high-accuracy xAI STT (only used on hands-free commits).
    // Browser SpeechRecognition gives us fast interim + wake word; xAI STT gives far better
    // Bible ref accuracy ("John one" → "John 1", "first John one" → "1 John 1", "Romans five" etc.).
    // Cost is negligible ($0.10–0.20 per hour of actual user speaking time).
    let mediaStream = null;
    let mediaRecorder = null;
    let audioChunks = [];
    let lastUtteranceAudioBlob = null;
    // When false, hands-free must not auto-restart (page hidden/closing, or hard release).
    // Without this, recognition.onend restarts the mic after we try to free it.
    let micAllowed = true;

    // For live server-improved STT during hands-free (debounced to avoid spam)
    let liveSttTimer = null;

    // Voice settings - cleaned up persistence
    let selectedVoice = null;
    let voiceSettings = {
      voiceSource: localStorage.getItem('voice_source') || 'local', // default local for zero cost
      voiceId: (localStorage.getItem('voice_id') || localStorage.getItem('voice_name') || '')
        .replace(/\s*\(System\)\s*$/i, '')
        .replace(/\s*\(System Voice\)\s*$/i, '')
        .replace(/\s*\(iOS\)\s*$/i, '')
        .replace(/\s*\(Piper Neural\)\s*$/i, '')
        .trim(),
      rate: parseFloat(localStorage.getItem('voice_rate')) || 0.95,
      pitch: parseFloat(localStorage.getItem('voice_pitch')) || 1.0
    };

    // Hands-free defaults OFF; only enabled when user explicitly turns it on.
    if (localStorage.getItem('handsfree_enabled') === null) {
      localStorage.setItem('handsfree_enabled', 'false');
    }
    let handsFreeEnabled = localStorage.getItem('handsfree_enabled') === 'true';
    let continuousMode = false;

    let TRIAL_DAYS = 7;
    let SITE_SHARE_URL = 'https://www.thewordincontext.org';

    // Legacy ?demo=1 links → clean URL (demo removed; signup required for chat)
    const urlParams = new URLSearchParams(window.location.search);
    if (urlParams.has('demo')) {
      urlParams.delete('demo');
      const clean = window.location.pathname + (urlParams.toString() ? '?' + urlParams.toString() : '') + window.location.hash;
      window.history.replaceState({}, '', clean);
    }

    function getEffectiveAuthToken() {
      return localStorage.getItem('auth_token');
    }

    function enforceAuthRequired() {
      const token = getEffectiveAuthToken();
      const input = document.getElementById('user-input');
      const send = document.getElementById('send-btn');
      const mic = document.getElementById('mic-btn');
      const banner = document.getElementById('demo-banner');
      const statusEl = document.getElementById('demo-status');
      if (token) {
        if (banner) banner.style.display = 'none';
        if (statusEl) statusEl.style.display = 'none';
        if (input) {
          input.disabled = false;
          input.placeholder = input.getAttribute('data-placeholder-desktop') || 'Ask about any passage, word, or verse in The Word...';
        }
        if (send) send.disabled = false;
        if (mic) {
          mic.disabled = false;
          mic.style.opacity = '';
          mic.title = 'Click or hold to speak';
        }
        return;
      }
      if (input) {
        input.disabled = true;
        input.placeholder = 'Sign up or log in to chat with John';
      }
      if (send) send.disabled = true;
      if (mic) {
        mic.disabled = true;
        mic.style.opacity = '0.35';
        mic.title = 'Sign up required';
      }
      if (banner) banner.style.display = 'block';
      if (statusEl) statusEl.style.display = 'none';
    }

    function showSignupPrompt() {
      if (document.querySelector('.demo-signup-prompt')) return;
      const div = document.createElement('div');
      div.className = 'demo-signup-prompt';
      div.style.cssText = 'margin:12px 0; padding:10px 14px; background:#f8f1e3; border:1px solid #c9a227; border-radius:8px; font-size:13px;';
      div.innerHTML = `Chat with John requires a free account. <a href="/#signup" style="color:#2c3e50;font-weight:600;">Start your ${TRIAL_DAYS}-day trial</a> or create a 14-day tester account with an invite code (no card). Already signed up? Click <strong>Log in</strong> above.`;
      messagesContainer.appendChild(div);
      messagesContainer.scrollTop = messagesContainer.scrollHeight;
    }

    function openLoginModal() {
      const modal = document.getElementById('subscribe-modal');
      const upgradeBtn = document.getElementById('upgrade-btn');
      if (upgradeBtn) upgradeBtn.click();
      else if (modal) modal.style.display = 'flex';
    }

    let pendingTranscript = null;
    let commitTimeout = null;
    let restartTimer = null;
    let isAwaitingResponse = false; // prevents auto-restart of mic while Grok is thinking or about to speak (reduces noise pickup + state thrashing)
    let wakeWordActiveUntil = 0; // timestamp until which we accept the next utterance as a command (after hearing the name with no command yet)
    let longPauseUntil = 0; // if user says "[wake] pause" or similar (or just pause words), we allow very long silence before auto-committing (up to this time)
    // True when this listen session was started by tapping the mic. That turn must send
    // like the Send button — no wake word, no 3s dead pause, flush on speech end.
    let tapToTalkTurn = false;
    let lastVoiceSendAt = 0;
    let justReleasedLiveMic = false;

    // === Multi-conversation persistence (Grok-like history) ===
    let chats = [];
    let currentChatId = null;

    const synth = window.speechSynthesis;

    function isIOSDevice() {
      return /iPad|iPhone|iPod/i.test(navigator.userAgent)
        || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
    }

    function isSafariBrowser() {
      const ua = navigator.userAgent;
      return /Safari/i.test(ua) && !/Chrome|CriOS|Chromium|Edg|EdgiOS|Firefox|FxiOS|OPR/i.test(ua);
    }

    // Engine wake helper. Browsers (especially iOS Safari) may not expose the full voice list
    // until speechSynthesis has been used from a user gesture at least once.
    let __ttsWoken = false;
    let __lastTtsWakeAt = 0;
    function wakeSpeechEngine(force) {
      if (__ttsWoken && !force) return;
      // Never interrupt real AI/manual speech — cancel() clears the whole WebKit queue.
      try {
        if (synth.speaking || synth.pending || (speechQueue && speechQueue.length > 0)) return;
      } catch (e) {}
      __ttsWoken = true;
      __lastTtsWakeAt = Date.now();
      try {
        try { synth.getVoices(); } catch (e) {}
        try { if (synth.paused) synth.resume(); } catch (e) {}
        const u = new SpeechSynthesisUtterance(' ');
        if (selectedVoice || (voiceSettings.voiceSource === 'local' && voiceSettings.voiceId)) {
          const target = selectedVoice || findLocalVoiceById(voiceSettings.voiceId);
          if (target) u.voice = target;
        }
        u.volume = 0.01;
        u.rate = 2;
        u.__isUnlock = true;
        synth.speak(u);
        // Let the silent unlock utterance finish on its own. cancel() after 80ms
        // left Chrome/WebKit with speaking/pending stuck true, so the next real
        // speak() canceled again and the answer sat on screen before John talked.
      } catch (e) {}
    }

    function getBrowserVoices() {
      try { return synth.getVoices() || []; } catch (e) { return []; }
    }

    function sortVoicesForDisplay(voices) {
      const list = voices.slice();
      if (isIOSDevice()) {
        const preferred = ['daniel', 'karen', 'samantha', 'moira', 'alex'];
        list.sort((a, b) => {
          const an = (a.name || '').toLowerCase();
          const bn = (b.name || '').toLowerCase();
          const ar = preferred.findIndex(p => an.includes(p));
          const br = preferred.findIndex(p => bn.includes(p));
          const aRank = ar === -1 ? 999 : ar;
          const bRank = br === -1 ? 999 : br;
          if (aRank !== bRank) return aRank - bRank;
          return an.localeCompare(bn);
        });
      } else {
        list.sort((a, b) => (a.name || '').localeCompare(b.name || ''));
      }
      return list;
    }

    function updateVoiceDiagnostics() {
      const el = document.getElementById('voice-diagnostics');
      if (!el) return;
      const voices = getBrowserVoices();
      const english = voices.filter(v => (v.lang || '').toLowerCase().startsWith('en'));
      const enhanced = voices.filter(v => /enhanced|premium|personal/i.test(v.name || ''));
      let html = `<strong>${voices.length}</strong> voice(s) from your browser`;
      if (english.length) html += ` · <strong>${english.length}</strong> English`;
      if (enhanced.length) html += ` · <strong>${enhanced.length}</strong> Enhanced`;
      if (voices.length === 0) {
        html += '. <span class="settings-diag-warn">Tap <strong>Unlock all voices</strong>.</span>';
      }
      if (isIOSDevice()) {
        html += '<br><span class="settings-diag-hint"><strong>iPhone:</strong> basic system voices only (any browser). Try <strong>Daniel</strong> or <strong>Karen</strong>.</span>';
      } else if (isSafariBrowser()) {
        html += '<br><span class="settings-diag-safari"><strong>Safari:</strong> limited voice list — use <strong>Chrome</strong> on Mac.</span>';
      } else {
        html += '<br><span class="settings-diag-hint"><strong>Mac:</strong> <strong>Chrome</strong> recommended for Enhanced voices.</span>';
      }
      el.innerHTML = html;
    }

    function scheduleVoiceListRefresh() {
      loadVoices();
      populateVoicePreviews();
      updateVoiceDiagnostics();
      setTimeout(() => { loadVoices(); populateVoicePreviews(); updateVoiceDiagnostics(); }, 300);
      setTimeout(() => { loadVoices(); populateVoicePreviews(); updateVoiceDiagnostics(); }, 900);
      setTimeout(() => { loadVoices(); populateVoicePreviews(); updateVoiceDiagnostics(); }, 1800);
      setTimeout(() => { loadVoices(); populateVoicePreviews(); updateVoiceDiagnostics(); }, 3500);
    }

    function unlockAllVoices() {
      wakeSpeechEngine(true);
      try { synth.getVoices(); } catch (e) {}
      const voices = getBrowserVoices();
      const pick = (selectedVoice || findLocalVoiceById(voiceSettings.voiceId))
        || voices.find(v => /enhanced|premium/i.test(v.name || ''))
        || (voices.length ? voices[0] : null);
      const utterance = new SpeechSynthesisUtterance('Unlocking voices. John 3:16.');
      if (pick) utterance.voice = pick;
      if (pick && pick.lang) utterance.lang = pick.lang;
      utterance.volume = 1.0;
      utterance.rate = voiceSettings.rate || 0.95;
      utterance.onend = scheduleVoiceListRefresh;
      utterance.onerror = scheduleVoiceListRefresh;
      if (synth.speaking) synth.cancel();
      setTimeout(() => {
        try { synth.speak(utterance); } catch (e) { scheduleVoiceListRefresh(); }
      }, 60);
    }

    // Back-compat alias
    function unlockIOSVoices() { unlockAllVoices(); }

    // Automatic first-gesture wake on any click/touch in the app. This helps ensure the speech
    // engine is activated early so later (including async) speaks work reliably.
    // On iOS, lightly re-prime on later gestures (throttled): WebKit can drop unlock after long
    // idle or after heavy mic use, which makes hands-free auto-speak silent until the next unlock.
    function setupGlobalTTSWake() {
      const handler = () => {
        try {
          if (synth.speaking || synth.pending || (speechQueue && speechQueue.length > 0)) return;
        } catch (e) {}
        const now = Date.now();
        const force = isIOSDevice() && (now - __lastTtsWakeAt > 8000);
        wakeSpeechEngine(force);
        if (isIOSDevice()) scheduleVoiceListRefresh();
      };
      if (isIOSDevice()) {
        document.addEventListener('click', handler, { passive: true });
        document.addEventListener('touchstart', handler, { passive: true });
      } else {
        document.addEventListener('click', handler, { once: true });
        document.addEventListener('touchstart', handler, { once: true });
      }
    }

    let hostedAudio = null;  // legacy guard only (server /api/tts for voices is disabled; all output uses synth)
    let lastSpokenText = '';
    let currentTranscript = '';
    let lastTranscriptConfidence = 0;
    let autoSpeakEnabled = localStorage.getItem('auto_speak_enabled') !== 'false'; // default true (with short text)
    let premiumVoicesEnabled = localStorage.getItem('premium_voices_enabled') === 'true'; // legacy flag (voices are now always local browser only)

    // Wake word customization (default "John", can turn off or change name)
    let wakeWordEnabled = localStorage.getItem('wake_word_enabled') !== 'false';
    let wakeWord = (localStorage.getItem('wake_word') || 'John').trim();
    if (!wakeWord) wakeWord = 'John';
    // Migration: force old "holy grok" (from early versions) to the neutral "John" default
    if (wakeWord.toLowerCase() === 'holy grok' || wakeWord.toLowerCase() === 'holy-grok' || wakeWord.toLowerCase() === 'holy_grok') {
      wakeWord = 'John';
      localStorage.setItem('wake_word', 'John');
    }

    function getWakeWordDisplay() {
      const w = (wakeWord || 'John').trim();
      if (!w) return 'John';
      return w;
    }

    function syncWakeWordPresetButtons() {
      const current = wakeWord.trim().toLowerCase();
      document.querySelectorAll('.wake-preset-btn').forEach((btn) => {
        const preset = (btn.getAttribute('data-wake') || '').trim().toLowerCase();
        btn.classList.toggle('active', preset === current);
      });
    }

    function initWakeWordPresets() {
      document.querySelectorAll('.wake-preset-btn').forEach((btn) => {
        btn.addEventListener('click', () => {
          const preset = btn.getAttribute('data-wake') || 'John';
          wakeWord = preset;
          const wakeInput = document.getElementById('wake-word-input');
          if (wakeInput) wakeInput.value = preset;
          syncWakeWordPresetButtons();
          if (typeof updateHandsFreeLabel === 'function') updateHandsFreeLabel();
        });
      });
    }

    function syncWakeWordSettingsUI() {
      const wakeEnabledToggle = document.getElementById('wake-enabled');
      if (wakeEnabledToggle) wakeEnabledToggle.checked = !!wakeWordEnabled;
      const wakeInput = document.getElementById('wake-word-input');
      if (wakeInput) wakeInput.value = getWakeWordDisplay();
      syncWakeWordPresetButtons();
    }
    let serverHasManagedTTS = false; // legacy flag only (voices are purely client window.speechSynthesis; server TTS path is disabled for voices)
    let serverHasSTT = false;        // populated from /api/health or /api/config; enables the cheap xAI STT path for hands-free voice input

    const ALLOWED_ENGLISH_TRANS = new Set(['BSB', 'eng_kjv', 'eng_net', 'eng_dby', 'eng_asv', 'eng_ylt', 'ENGWEBP']);

    const BIBLE_LIBRARY = {
      ot: [
        { name: 'Genesis', code: 'GEN', chapters: 50 },
        { name: 'Exodus', code: 'EXO', chapters: 40 },
        { name: 'Leviticus', code: 'LEV', chapters: 27 },
        { name: 'Numbers', code: 'NUM', chapters: 36 },
        { name: 'Deuteronomy', code: 'DEU', chapters: 34 },
        { name: 'Joshua', code: 'JOS', chapters: 24 },
        { name: 'Judges', code: 'JDG', chapters: 21 },
        { name: 'Ruth', code: 'RUT', chapters: 4 },
        { name: '1 Samuel', code: '1SA', chapters: 31 },
        { name: '2 Samuel', code: '2SA', chapters: 24 },
        { name: '1 Kings', code: '1KI', chapters: 22 },
        { name: '2 Kings', code: '2KI', chapters: 25 },
        { name: '1 Chronicles', code: '1CH', chapters: 29 },
        { name: '2 Chronicles', code: '2CH', chapters: 36 },
        { name: 'Ezra', code: 'EZR', chapters: 10 },
        { name: 'Nehemiah', code: 'NEH', chapters: 13 },
        { name: 'Esther', code: 'EST', chapters: 10 },
        { name: 'Job', code: 'JOB', chapters: 42 },
        { name: 'Psalms', code: 'PSA', chapters: 150 },
        { name: 'Proverbs', code: 'PRO', chapters: 31 },
        { name: 'Ecclesiastes', code: 'ECC', chapters: 12 },
        { name: 'Song of Solomon', code: 'SNG', chapters: 8 },
        { name: 'Isaiah', code: 'ISA', chapters: 66 },
        { name: 'Jeremiah', code: 'JER', chapters: 52 },
        { name: 'Lamentations', code: 'LAM', chapters: 5 },
        { name: 'Ezekiel', code: 'EZE', chapters: 48 },
        { name: 'Daniel', code: 'DAN', chapters: 12 },
        { name: 'Hosea', code: 'HOS', chapters: 14 },
        { name: 'Joel', code: 'JOL', chapters: 3 },
        { name: 'Amos', code: 'AMO', chapters: 9 },
        { name: 'Obadiah', code: 'OBA', chapters: 1 },
        { name: 'Jonah', code: 'JON', chapters: 4 },
        { name: 'Micah', code: 'MIC', chapters: 7 },
        { name: 'Nahum', code: 'NAM', chapters: 3 },
        { name: 'Habakkuk', code: 'HAB', chapters: 3 },
        { name: 'Zephaniah', code: 'ZEP', chapters: 3 },
        { name: 'Haggai', code: 'HAG', chapters: 2 },
        { name: 'Zechariah', code: 'ZEC', chapters: 14 },
        { name: 'Malachi', code: 'MAL', chapters: 4 }
      ],
      nt: [
        { name: 'Matthew', code: 'MAT', chapters: 28 },
        { name: 'Mark', code: 'MRK', chapters: 16 },
        { name: 'Luke', code: 'LUK', chapters: 24 },
        { name: 'John', code: 'JHN', chapters: 21 },
        { name: 'Acts', code: 'ACT', chapters: 28 },
        { name: 'Romans', code: 'ROM', chapters: 16 },
        { name: '1 Corinthians', code: '1CO', chapters: 16 },
        { name: '2 Corinthians', code: '2CO', chapters: 13 },
        { name: 'Galatians', code: 'GAL', chapters: 6 },
        { name: 'Ephesians', code: 'EPH', chapters: 6 },
        { name: 'Philippians', code: 'PHP', chapters: 4 },
        { name: 'Colossians', code: 'COL', chapters: 4 },
        { name: '1 Thessalonians', code: '1TH', chapters: 5 },
        { name: '2 Thessalonians', code: '2TH', chapters: 3 },
        { name: '1 Timothy', code: '1TI', chapters: 6 },
        { name: '2 Timothy', code: '2TI', chapters: 4 },
        { name: 'Titus', code: 'TIT', chapters: 3 },
        { name: 'Philemon', code: 'PHM', chapters: 1 },
        { name: 'Hebrews', code: 'HEB', chapters: 13 },
        { name: 'James', code: 'JAS', chapters: 5 },
        { name: '1 Peter', code: '1PE', chapters: 5 },
        { name: '2 Peter', code: '2PE', chapters: 3 },
        { name: '1 John', code: '1JN', chapters: 5 },
        { name: '2 John', code: '2JN', chapters: 1 },
        { name: '3 John', code: '3JN', chapters: 1 },
        { name: 'Jude', code: 'JUD', chapters: 1 },
        { name: 'Revelation', code: 'REV', chapters: 22 }
      ]
    };

    const BIBLE_API_ORIGIN = 'https://bible.helloao.org';
    const LIBRARY_ENGLISH_TRANS = [
      { id: 'BSB', name: 'Berean Standard Bible', short: 'BSB' },
      { id: 'eng_kjv', name: 'King James Version', short: 'KJV' },
      { id: 'eng_net', name: 'NET Bible', short: 'NET' },
      { id: 'eng_dby', name: 'Darby Translation', short: 'DBY' },
      { id: 'eng_asv', name: 'American Standard Version', short: 'ASV' },
      { id: 'eng_ylt', name: "Young's Literal Translation", short: 'YLT' },
      { id: 'ENGWEBP', name: 'World English Bible', short: 'WEB' }
    ];
    const LIBRARY_LANG_OPTIONS = [
      { code: 'eng', name: 'English' },
      { code: 'spa', name: 'Spanish' },
      { code: 'fra', name: 'French' },
      { code: 'deu', name: 'German' },
      { code: 'por', name: 'Portuguese' },
      { code: 'cmn', name: 'Chinese (Mandarin)' },
      { code: 'kor', name: 'Korean' },
      { code: 'jpn', name: 'Japanese' },
      { code: 'rus', name: 'Russian' },
      { code: 'ita', name: 'Italian' },
      { code: 'nld', name: 'Dutch' },
      { code: 'pol', name: 'Polish' },
      { code: 'hin', name: 'Hindi' },
      { code: 'vie', name: 'Vietnamese' },
      { code: 'ind', name: 'Indonesian' },
      { code: 'tgl', name: 'Tagalog' },
      { code: 'ukr', name: 'Ukrainian' },
      { code: 'heb', name: 'Hebrew' },
      { code: 'swh', name: 'Swahili' }
    ];
    const LIBRARY_LANG_DEFAULT_TRANS = {
      eng: 'BSB',
      spa: 'spa_r09',
      fra: 'fra_lsg',
      deu: 'deu_l12',
      por: 'por_blj',
      cmn: 'cmn_cu1',
      kor: 'kor_old',
      jpn: 'jpn_loc',
      rus: 'rus_syn',
      ita: 'ita_riv',
      nld: 'nld_nbg',
      pol: 'pol_ubg',
      hin: 'HINIRV',
      vie: 'vie_vcb',
      ind: 'ind_ayt',
      tgl: 'tgl_ulb',
      ukr: 'ukr_ufb',
      heb: 'heb_mod',
      swh: 'swh_bib'
    };
    const LIBRARY_SPEAK_LANG = {
      eng: 'en-US',
      spa: 'es-ES',
      fra: 'fr-FR',
      deu: 'de-DE',
      por: 'pt-BR',
      cmn: 'zh-CN',
      kor: 'ko-KR',
      jpn: 'ja-JP',
      rus: 'ru-RU',
      ita: 'it-IT',
      nld: 'nl-NL',
      pol: 'pl-PL',
      hin: 'hi-IN',
      vie: 'vi-VN',
      ind: 'id-ID',
      tgl: 'fil-PH',
      ukr: 'uk-UA',
      heb: 'he-IL',
      swh: 'sw-KE'
    };
    let bibleTranslationsCatalog = null;
    let bibleTranslationsPromise = null;

    const NT_BOOK_CODES = new Set(
      BIBLE_LIBRARY.nt.map((b) => b.code)
    );

    let librarySelectedBook = null;
    let librarySelectedChapter = null;
    let libraryView = 'books';
    let libraryChapterVerses = [];
    let offlineBibleCompleteByTrans = {};
    let offlineBibleLoadPromises = {};
    let offlineTranslationCache = {};
    let offlineTranslationPromises = {};
    let studyLexicon = null;
    let studyLexiconPromise = null;

    function isDarkMode() {
      return localStorage.getItem('dark_mode') === 'true';
    }

    function applyDarkMode(enabled) {
      document.documentElement.setAttribute('data-theme', enabled ? 'dark' : 'light');
      localStorage.setItem('dark_mode', enabled ? 'true' : 'false');
      const btn = document.getElementById('dark-mode-btn');
      if (btn) btn.textContent = enabled ? '☀️' : '🌙';
      const toggle = document.getElementById('dark-mode-toggle');
      if (toggle) toggle.checked = enabled;
      const metaTheme = document.querySelector('meta[name="theme-color"]');
      if (metaTheme) metaTheme.setAttribute('content', enabled ? '#0f1419' : '#2c3e50');
    }

    function initDarkMode() {
      applyDarkMode(isDarkMode());
      const btn = document.getElementById('dark-mode-btn');
      if (btn) {
        btn.addEventListener('click', () => applyDarkMode(!isDarkMode()));
      }
      const toggle = document.getElementById('dark-mode-toggle');
      if (toggle) {
        toggle.checked = isDarkMode();
        toggle.addEventListener('change', () => applyDarkMode(toggle.checked));
      }
    }

    function switchMainView(view) {
      const chatPanel = document.getElementById('chat-panel');
      const libraryPanel = document.getElementById('library-panel');
      const tabChat = document.getElementById('tab-chat');
      const tabLibrary = document.getElementById('tab-library');
      const isChat = view === 'chat';

      if (chatPanel) chatPanel.classList.toggle('hidden', !isChat);
      if (libraryPanel) {
        libraryPanel.classList.toggle('active', !isChat);
        libraryPanel.setAttribute('aria-hidden', isChat ? 'true' : 'false');
      }
      if (tabChat) {
        tabChat.classList.toggle('active', isChat);
        tabChat.setAttribute('aria-selected', isChat ? 'true' : 'false');
      }
      if (tabLibrary) {
        tabLibrary.classList.toggle('active', !isChat);
        tabLibrary.setAttribute('aria-selected', !isChat ? 'true' : 'false');
      }
    }

    function initMainTabs() {
      const tabChat = document.getElementById('tab-chat');
      const tabLibrary = document.getElementById('tab-library');
      if (tabChat) tabChat.addEventListener('click', () => switchMainView('chat'));
      if (tabLibrary) tabLibrary.addEventListener('click', () => switchMainView('library'));

      const params = new URLSearchParams(window.location.search);
      if (params.get('view') === 'library') {
        switchMainView('library');
      }
    }

    function migrateLibraryTransStorage() {
      const legacy = localStorage.getItem('library_english_trans');
      if (legacy && !localStorage.getItem('library_reading_trans')) {
        localStorage.setItem('library_reading_trans', legacy);
        localStorage.setItem('library_reading_lang', 'eng');
      }
    }

    async function loadBibleTranslationsCatalog() {
      if (bibleTranslationsCatalog) return bibleTranslationsCatalog;
      if (bibleTranslationsPromise) return bibleTranslationsPromise;
      bibleTranslationsPromise = (async () => {
        const res = await fetch(`${BIBLE_API_ORIGIN}/api/available_translations.json`);
        if (!res.ok) throw new Error('Translation list unavailable');
        const data = await res.json();
        const list = Array.isArray(data?.translations) ? data.translations : [];
        bibleTranslationsCatalog = list.filter((t) => t && t.id && (t.numberOfBooks || 0) >= 1);
        return bibleTranslationsCatalog;
      })();
      try {
        return await bibleTranslationsPromise;
      } catch (err) {
        bibleTranslationsPromise = null;
        throw err;
      }
    }

    function getLibraryReadingLang() {
      migrateLibraryTransStorage();
      const saved = localStorage.getItem('library_reading_lang');
      if (saved && LIBRARY_LANG_OPTIONS.some((l) => l.code === saved)) return saved;
      return 'eng';
    }

    function setLibraryReadingLang(langCode) {
      const code = LIBRARY_LANG_OPTIONS.some((l) => l.code === langCode) ? langCode : 'eng';
      localStorage.setItem('library_reading_lang', code);
      return code;
    }

    function getTranslationsForLanguage(langCode) {
      const code = langCode || getLibraryReadingLang();
      if (!bibleTranslationsCatalog) {
        if (code === 'eng') {
          return LIBRARY_ENGLISH_TRANS.map((t) => ({
            id: t.id,
            englishName: t.name,
            name: t.name,
            shortName: t.short,
            language: 'eng',
            languageEnglishName: 'English',
            numberOfBooks: 66
          }));
        }
        return [];
      }
      return bibleTranslationsCatalog
        .filter((t) => t.language === code)
        .sort((a, b) => {
          const aFull = (a.numberOfBooks || 0) >= 66 ? 0 : 1;
          const bFull = (b.numberOfBooks || 0) >= 66 ? 0 : 1;
          if (aFull !== bFull) return aFull - bFull;
          return (a.englishName || a.name || a.id).localeCompare(b.englishName || b.name || b.id);
        });
    }

    function findTranslationMeta(transId) {
      const id = transId || getLibraryTranslationId();
      if (bibleTranslationsCatalog) {
        const hit = bibleTranslationsCatalog.find((t) => t.id === id);
        if (hit) {
          return {
            id: hit.id,
            name: hit.englishName || hit.name || hit.id,
            short: hit.shortName || hit.id,
            language: hit.language || getLibraryReadingLang(),
            languageName: hit.languageEnglishName || hit.languageName || ''
          };
        }
      }
      const eng = LIBRARY_ENGLISH_TRANS.find((t) => t.id === id);
      if (eng) {
        return { ...eng, language: 'eng', languageName: 'English' };
      }
      return {
        id,
        name: id,
        short: id,
        language: getLibraryReadingLang(),
        languageName: LIBRARY_LANG_OPTIONS.find((l) => l.code === getLibraryReadingLang())?.name || ''
      };
    }

    function formatLibraryTransOptionLabel(trans) {
      const short = trans.shortName || trans.id;
      const name = trans.englishName || trans.name || trans.id;
      const books = trans.numberOfBooks || 0;
      const suffix = books && books < 66 ? ` (${books} books)` : '';
      return `${short} — ${name}${suffix}`;
    }

    function populateLibraryTransSelectElement(selectEl, langCode, selectedId) {
      if (!selectEl) return selectedId;
      const lang = langCode || getLibraryReadingLang();
      const translations = getTranslationsForLanguage(lang);
      const prev = selectedId || getLibraryTranslationId();
      let nextId = prev;
      if (!translations.some((t) => t.id === nextId)) {
        nextId = LIBRARY_LANG_DEFAULT_TRANS[lang] || translations[0]?.id || 'BSB';
      }
      selectEl.innerHTML = translations.length
        ? translations.map((t) => {
            const label = formatLibraryTransOptionLabel(t);
            return `<option value="${t.id}">${label.replace(/</g, '&lt;')}</option>`;
          }).join('')
        : '<option value="BSB">English — Berean Standard Bible</option>';
      selectEl.value = translations.some((t) => t.id === nextId) ? nextId : (translations[0]?.id || 'BSB');
      return selectEl.value;
    }

    function syncLibraryTranslationSelectors(selectedId) {
      const lang = getLibraryReadingLang();
      const id = populateLibraryTransSelectElement(
        document.getElementById('library-trans-select'),
        lang,
        selectedId
      );
      populateLibraryTransSelectElement(
        document.getElementById('library-reading-trans-select'),
        lang,
        id
      );
      const langSel = document.getElementById('library-lang-select');
      if (langSel) langSel.value = lang;
      return id;
    }

    function getLibraryTranslationId() {
      migrateLibraryTransStorage();
      let saved = localStorage.getItem('library_reading_trans');
      if (!saved) saved = LIBRARY_LANG_DEFAULT_TRANS[getLibraryReadingLang()] || getDefaultEnglishTrans();
      const lang = getLibraryReadingLang();
      const options = getTranslationsForLanguage(lang);
      if (options.length && !options.some((t) => t.id === saved)) {
        saved = LIBRARY_LANG_DEFAULT_TRANS[lang] || options[0].id;
      }
      return saved || 'BSB';
    }

    function getLibraryTranslationInfo() {
      return findTranslationMeta(getLibraryTranslationId());
    }

    function getLibrarySpeakLangBcp47() {
      const info = getLibraryTranslationInfo();
      return LIBRARY_SPEAK_LANG[info.language] || LIBRARY_SPEAK_LANG.eng;
    }

    function setLibraryTranslationId(transId, langCode) {
      const lang = langCode ? setLibraryReadingLang(langCode) : getLibraryReadingLang();
      const options = getTranslationsForLanguage(lang);
      let id = transId;
      if (!options.some((t) => t.id === id)) {
        id = LIBRARY_LANG_DEFAULT_TRANS[lang] || options[0]?.id || 'BSB';
      }
      const prev = getLibraryTranslationId();
      localStorage.setItem('library_reading_trans', id);
      localStorage.setItem('library_reading_lang', lang);
      if (prev !== id) {
        delete offlineBibleCompleteByTrans[id];
        delete offlineBibleLoadPromises[id];
      }
      syncLibraryTranslationSelectors(id);
      updateLibraryMeta();
      return id;
    }

    function updateLibraryMeta() {
      const meta = document.getElementById('library-meta');
      if (!meta) return;
      const info = getLibraryTranslationInfo();
      const offline = !navigator.onLine;
      meta.classList.toggle('offline', offline);
      const langPrefix = info.languageName ? `${info.languageName} · ` : '';
      meta.textContent = offline
        ? `${langPrefix}${info.name} — reading from offline cache when available`
        : `${langPrefix}${info.name} — cached for offline reading`;
    }

    async function refreshLibraryLanguageUI(selectedId) {
      try {
        await loadBibleTranslationsCatalog();
      } catch (e) {
        console.warn('[Library] translation catalog unavailable, using English defaults:', e);
      }
      const id = syncLibraryTranslationSelectors(selectedId || getLibraryTranslationId());
      setLibraryTranslationId(id, getLibraryReadingLang());
      updateLibraryMeta();
    }

    function populateLibraryLanguageSelect() {
      const langSel = document.getElementById('library-lang-select');
      if (!langSel) return;
      langSel.innerHTML = LIBRARY_LANG_OPTIONS.map((l) =>
        `<option value="${l.code}">${l.name}</option>`
      ).join('');
      langSel.value = getLibraryReadingLang();
    }

    async function onLibraryLanguageChanged(langCode) {
      const lang = setLibraryReadingLang(langCode);
      const defaultId = LIBRARY_LANG_DEFAULT_TRANS[lang] || getTranslationsForLanguage(lang)[0]?.id || 'BSB';
      await refreshLibraryLanguageUI(defaultId);
      preloadOfflineBible();
      await reloadLibraryAfterTranslationChange();
    }

    async function onLibraryTranslationChanged(transId) {
      setLibraryTranslationId(transId);
      preloadOfflineBible();
      await reloadLibraryAfterTranslationChange();
    }

    async function reloadLibraryAfterTranslationChange() {
      if (libraryView === 'verses' && librarySelectedBook && librarySelectedChapter) {
        await renderLibraryVerses(librarySelectedBook, librarySelectedChapter);
      } else if (libraryView === 'chapters' && librarySelectedBook) {
        renderLibraryChapters(librarySelectedBook);
      } else {
        renderLibraryBooks(document.getElementById('library-search')?.value || '');
      }
    }

    function initLibraryLanguageSettings() {
      populateLibraryLanguageSelect();
      const langSel = document.getElementById('library-lang-select');
      const settingsTransSel = document.getElementById('library-reading-trans-select');
      if (langSel) {
        langSel.addEventListener('change', () => onLibraryLanguageChanged(langSel.value));
      }
      if (settingsTransSel) {
        settingsTransSel.addEventListener('change', () => onLibraryTranslationChanged(settingsTransSel.value));
      }
    }

    function initLibraryTranslationSelector() {
      const sel = document.getElementById('library-trans-select');
      if (!sel) return;
      sel.addEventListener('change', () => onLibraryTranslationChanged(sel.value));
    }

    function bibleContentPartText(part) {
      if (typeof part === 'string') return part;
      if (!part || typeof part !== 'object') return '';
      if (part.noteId != null && !part.text && !Array.isArray(part.content) && !Array.isArray(part.words)) return '';
      if (part && typeof part.text === 'string') return part.text;
      if (Array.isArray(part.content)) return part.content.map(bibleContentPartText).join(' ');
      return '';
    }

    function parseChapterContent(content) {
      const blocks = [];
      if (!Array.isArray(content)) return blocks;

      for (const item of content) {
        if (item.type === 'heading' && Array.isArray(item.content)) {
          blocks.push({
            type: 'heading',
            text: item.content.map(bibleContentPartText).join(' ').trim()
          });
        } else if (item.type === 'verse' && typeof item.number === 'number') {
          const text = (item.content || [])
            .map(bibleContentPartText)
            .join(' ')
            .replace(/\s+/g, ' ')
            .trim();
          if (text) {
            blocks.push({ type: 'verse', number: item.number, text });
          }
        }
      }
      return blocks;
    }

    async function preloadOfflineBible() {
      try {
        await Promise.allSettled([
          loadOfflineBibleComplete(),
          loadStudyLexicon(),
          loadOfflineTranslation('grc_sbl'),
          loadOfflineTranslation('hbo_wlc'),
          loadOfflineTranslation('grc_bre')
        ]);
      } catch (e) {
        console.warn('[Library] offline Bible preload failed:', e);
      }
    }

    async function loadStudyLexicon() {
      if (studyLexicon) return studyLexicon;
      if (studyLexiconPromise) return studyLexiconPromise;
      studyLexiconPromise = (async () => {
        const res = await fetch('/data/study-lexicon.json?v=2');
        if (!res.ok) throw new Error('Lexicon unavailable');
        studyLexicon = await res.json();
        return studyLexicon;
      })();
      try {
        return await studyLexiconPromise;
      } catch (err) {
        studyLexiconPromise = null;
        throw err;
      }
    }

    async function loadOfflineTranslation(transId) {
      if (offlineTranslationCache[transId]) return offlineTranslationCache[transId];
      if (offlineTranslationPromises[transId]) return offlineTranslationPromises[transId];

      offlineTranslationPromises[transId] = (async () => {
        const url = `${BIBLE_API_ORIGIN}/api/${transId}/complete.json`;
        const res = await fetch(url);
        if (!res.ok) throw new Error(`${transId} unavailable (${res.status})`);
        const data = await res.json();
        if (!data || !Array.isArray(data.books)) throw new Error(`Invalid ${transId} data`);
        offlineTranslationCache[transId] = data;
        return data;
      })();

      try {
        return await offlineTranslationPromises[transId];
      } catch (err) {
        delete offlineTranslationPromises[transId];
        throw err;
      }
    }

    function getVerseTextFromComplete(complete, bookCode, chapterNum, verseNum) {
      const book = complete.books.find((b) => b.id === bookCode);
      if (!book || !Array.isArray(book.chapters)) return null;
      const entry = book.chapters.find((c) => c.chapter && c.chapter.number === chapterNum);
      if (!entry || !entry.chapter || !Array.isArray(entry.chapter.content)) return null;
      const blocks = parseChapterContent(entry.chapter.content);
      const verse = blocks.find((b) => b.type === 'verse' && b.number === verseNum);
      return verse ? verse.text : null;
    }

    async function fetchOriginalVerseFromApi(transId, bookCode, chapterNum, verseNum) {
      try {
        const complete = await loadOfflineTranslation(transId);
        const text = getVerseTextFromComplete(complete, bookCode, chapterNum, verseNum);
        if (text) return text;
      } catch (e) {}

      const url = `${BIBLE_API_ORIGIN}/api/${transId}/${bookCode}/${chapterNum}.json`;
      const res = await fetch(url);
      if (!res.ok) return null;
      const data = await res.json();
      const blocks = parseChapterContent(data?.chapter?.content || []);
      const verse = blocks.find((b) => b.type === 'verse' && b.number === verseNum);
      return verse ? verse.text : null;
    }

    async function fetchOriginalVerseTexts(bookCode, chapterNum, verseNum, isNT) {
      if (isNT) {
        const greek = await fetchOriginalVerseFromApi('grc_sbl', bookCode, chapterNum, verseNum);
        return {
          originalText: greek,
          originalLabel: 'SBL Greek NT',
          lang: 'greek'
        };
      }

      const hebrew = await fetchOriginalVerseFromApi('hbo_wlc', bookCode, chapterNum, verseNum);
      return {
        originalText: hebrew,
        originalLabel: 'Westminster Leningrad Codex (Hebrew)',
        lang: 'hebrew'
      };
    }

    const GREEK_FORM_ALIASES = {
      'ηγαπησεν': 'αγαπαω', 'ηγαπησαν': 'αγαπαω', 'ηγαπηκασι': 'αγαπαω', 'ηγαπημεν': 'αγαπαω',
      'ηγαπησα': 'αγαπαω', 'αγαπησεν': 'αγαπαω', 'αγαπησαν': 'αγαπαω', 'αγαπησει': 'αγαπαω',
      'εδωκεν': 'διδωμι', 'εδωκαν': 'διδωμι', 'εδωκα': 'διδωμι', 'δωσει': 'διδωμι', 'δωσω': 'διδωμι',
      'εχη': 'εχω', 'εχει': 'εχω', 'εχουσιν': 'εχω', 'εχετε': 'εχω', 'εχομεν': 'εχω', 'εσχον': 'εχω',
      'υιον': 'υιος', 'υιου': 'υιος', 'υιοι': 'υιος', 'υιω': 'υιος',
      'κοσμον': 'κοσμος', 'κοσμου': 'κοσμος', 'κοσμω': 'κοσμος',
      'πιστευων': 'πιστευω', 'πιστευουσιν': 'πιστευω', 'πιστευετε': 'πιστευω', 'πιστευσαν': 'πιστευω',
      'πιστευση': 'πιστευω', 'επιστευσαν': 'πιστευω',
      'αποληται': 'απολλυμι', 'απολωνται': 'απολλυμι', 'απολεσθαι': 'απολλυμι',
      'ζωην': 'ζωη', 'ζωης': 'ζωη', 'ζωη': 'ζωη',
      'αιωνιον': 'αιωνιος', 'αιωνιος': 'αιωνιος', 'αιωνιου': 'αιωνιος',
      'μονογενη': 'μονογενης', 'μονογενους': 'μονογενης',
      'αυτον': 'αυτος', 'αυτου': 'αυτος', 'αυτοις': 'αυτος', 'αυτοι': 'αυτος', 'αυτην': 'αυτος',
      'λογον': 'λογος', 'λογου': 'λογος', 'λογω': 'λογος',
      'θεον': 'θεος', 'θεου': 'θεος', 'θεω': 'θεος',
      'ουρανον': 'ουρανος', 'ουρανου': 'ουρανος',
      'γην': 'γη', 'γης': 'γη',
      'φωτος': 'φως', 'φωτι': 'φως',
      'αρχην': 'αρχη', 'αρχης': 'αρχη',
      'σωθη': 'σωζω', 'σωθηναι': 'σωζω', 'εσωθη': 'σωζω', 'σωζει': 'σωζω',
      'ειπεν': 'λεγω', 'λεγει': 'λεγω', 'ειπαν': 'λεγω', 'λεγουσιν': 'λεγω',
      'εποιησεν': 'ποιεω', 'εποιησαν': 'ποιεω', 'ποιει': 'ποιεω',
      'ην': 'ειμι', 'εστιν': 'ειμι', 'εστε': 'ειμι', 'εσμεν': 'ειμι'
    };

    function normalizeGreekToken(token) {
      return token
        .replace(/[⸀⸁⸂⸃.,;:!?'"""''()[\]{}«»—–·]/g, '')
        .normalize('NFD')
        .replace(/\p{M}/gu, '')
        .toLowerCase();
    }

    function normalizeHebrewToken(token) {
      return token
        .replace(/[.,;:!?'"""''()[\]{}—–·׃]/g, '')
        .normalize('NFD')
        .replace(/[\u0591-\u05C7]/g, '')
        .replace(/[^\u05D0-\u05EA]/g, '')
        .trim();
    }

    function greekStemCandidates(norm) {
      const candidates = [norm];
      const endings = [
        'ησεν', 'ησαν', 'ηκασι', 'ημεν', 'ησα', 'ησαι', 'ηται', 'ησθε',
        'σεν', 'σαν', 'σαι', 'σει', 'ται', 'μαι', 'ονται', 'ομαι', 'εται',
        'ειν', 'ει', 'ην', 'η', 'ων', 'ος', 'ον', 'ους', 'ου', 'ας', 'ης',
        'αν', 'ατε', 'ομεν', 'ετε', 'ουσι', 'υσι', 'υς', 'ες', 'εις'
      ];
      for (const end of endings) {
        if (norm.endsWith(end) && norm.length - end.length >= 3) {
          candidates.push(norm.slice(0, -end.length));
        }
      }
      const augmented = [...candidates];
      for (const c of augmented) {
        if (c.startsWith('η') && c.length > 4) candidates.push(c.slice(1));
        if (c.startsWith('ε') && c.length > 4) candidates.push(c.slice(1));
      }
      return [...new Set(candidates)];
    }

    function hebrewStemCandidates(norm) {
      const candidates = [norm];
      const prefixes = ['ו', 'ה', 'ב', 'כ', 'ל', 'מ', 'ש'];
      for (const p of prefixes) {
        if (norm.startsWith(p) && norm.length > 2) candidates.push(norm.slice(1));
      }
      return [...new Set(candidates)];
    }

    function findLexiconEntry(raw, lang) {
      if (!studyLexicon || !raw) return null;
      const dict = lang === 'hebrew' ? studyLexicon.hebrew : studyLexicon.greek;
      if (!dict) return null;

      const norm = lang === 'hebrew' ? normalizeHebrewToken(raw) : normalizeGreekToken(raw);
      if (!norm || norm.length < 2) return null;

      const aliasLemma = lang === 'greek' ? GREEK_FORM_ALIASES[norm] : null;
      if (aliasLemma && dict[aliasLemma]) {
        return { token: raw, lemma: aliasLemma, ...dict[aliasLemma] };
      }
      if (dict[norm]) {
        return { token: raw, lemma: norm, ...dict[norm] };
      }

      const candidates = lang === 'greek' ? greekStemCandidates(norm) : hebrewStemCandidates(norm);
      let best = null;
      let bestScore = 0;

      for (const cand of candidates) {
        const alias = lang === 'greek' ? GREEK_FORM_ALIASES[cand] : null;
        const lemmaKey = alias || cand;
        if (dict[lemmaKey]) {
          const score = lemmaKey.length + 120;
          if (score > bestScore) {
            best = { token: raw, lemma: lemmaKey, ...dict[lemmaKey] };
            bestScore = score;
          }
        }
        for (const key of Object.keys(dict)) {
          if (key.length < 3) continue;
          const stemLen = Math.min(5, key.length);
          const stem = key.slice(0, stemLen);
          if (stem.length < 4) continue;
          const containsStem = cand.includes(stem);
          const keyStartsCand = key.startsWith(cand) && cand.length >= 4;
          const candStartsKey = cand.startsWith(key) && key.length >= 3;
          if (!containsStem && !keyStartsCand && !candStartsKey) continue;
          const score = stem.length + (cand === key ? 40 : 0) + (containsStem ? 10 : 0);
          if (cand.length < 3 && key !== cand) continue;
          if (score > bestScore) {
            best = { token: raw, lemma: key, ...dict[key] };
            bestScore = score;
          }
        }
      }
      return best;
    }

    function lookupLexiconWords(text, lang, max = 8) {
      if (!studyLexicon || !text) return [];
      const rawTokens = text.split(/\s+/).filter(Boolean);
      const seen = new Set();
      const matches = [];

      for (const raw of rawTokens) {
        const entry = findLexiconEntry(raw, lang);
        if (!entry) continue;
        const dedupeKey = entry.lemma || entry.translit;
        if (seen.has(dedupeKey)) continue;
        seen.add(dedupeKey);
        matches.push({
          token: entry.token,
          translit: entry.translit,
          gloss: entry.gloss,
          note: entry.note || ''
        });
        if (matches.length >= max) break;
      }
      return matches;
    }

    function findSectionHeading(verses, verseNum) {
      let heading = '';
      for (const v of verses) {
        if (v.type === 'heading') heading = v.text;
        if (v.type === 'verse' && v.number === verseNum) break;
      }
      return heading;
    }

    function getNeighborVerses(verses, verseNum, bookName, chapterNum) {
      const onlyVerses = verses.filter((v) => v.type === 'verse');
      const idx = onlyVerses.findIndex((v) => v.number === verseNum);
      const prev = idx > 0
        ? { ref: `${bookName} ${chapterNum}:${onlyVerses[idx - 1].number}`, text: onlyVerses[idx - 1].text }
        : null;
      const next = idx >= 0 && idx < onlyVerses.length - 1
        ? { ref: `${bookName} ${chapterNum}:${onlyVerses[idx + 1].number}`, text: onlyVerses[idx + 1].text }
        : null;
      return { prev, next };
    }

    function formatLexWordLine(w) {
      const note = w.note ? ` ${w.note}` : '';
      return `• ${w.translit} — ${w.gloss}.${note}`.trim();
    }

    function buildContextNarrative(opts) {
      const langName = opts.isNT ? 'Greek' : 'Hebrew';
      const parts = [];
      parts.push(`"${opts.english}"`);
      if (opts.prev) {
        parts.push(`follows ${opts.prev.ref} ("${opts.prev.text}")`);
      }
      if (opts.next) {
        parts.push(`and leads into ${opts.next.ref} ("${opts.next.text}")`);
      }
      let narrative = `${opts.ref} in context: ${parts.join(', ')}.`;
      if (opts.lexWords.length) {
        const terms = opts.lexWords
          .slice(0, 6)
          .map((w) => `${w.translit} ("${w.gloss}")`)
          .join(', ');
        narrative += ` In ${langName}, the major words are ${terms}.`;
        const lead = opts.lexWords.slice(0, 3).map((w) => {
          const detail = w.note ? ` ${w.note}` : '';
          return `${w.translit} means "${w.gloss}"${detail ? ' —' + detail : ''}`;
        }).join('; ');
        narrative += ` So in English: ${lead}.`;
        narrative += ` Together these ${langName} terms show what this verse is saying within its immediate passage — not an outside interpretation, but the sense carried by the original words in their literary setting.`;
      } else if (opts.originalText) {
        narrative += ` The original ${langName} text is shown above; surrounding verses help place this line in the flow of the chapter.`;
      }
      return narrative;
    }

    function buildContextExplanation(opts) {
      const langName = opts.isNT ? 'Greek' : 'Hebrew';
      const lines = [];
      if (opts.heading) lines.push(`Setting: ${opts.heading}`);
      lines.push(`${opts.ref} (${opts.translationShort || 'BSB'})`);
      lines.push(`English: "${opts.english}"`);
      if (opts.originalText) {
        lines.push(`${langName} (${opts.originalLabel}): ${opts.originalText}`);
      }
      if (opts.prev) {
        lines.push(`Before: ${opts.prev.ref} — "${opts.prev.text}"`);
      }
      if (opts.next) {
        lines.push(`After: ${opts.next.ref} — "${opts.next.text}"`);
      }
      if (opts.lexWords.length) {
        lines.push('');
        lines.push(`Major ${langName} words (Roman spelling):`);
        opts.lexWords.forEach((w) => lines.push(formatLexWordLine(w)));
        lines.push('');
        lines.push('Context in English:');
        lines.push(buildContextNarrative(opts));
      } else {
        lines.push('');
        lines.push(`Context in English: ${buildContextNarrative(opts)}`);
      }
      return lines.join('\n');
    }

    function buildOriginalWordsExplanation(opts) {
      const langName = opts.lang === 'hebrew' ? 'Hebrew' : 'Greek';
      const lines = [];
      lines.push(`${opts.originalLabel}`);
      lines.push(opts.originalText || `[${langName} text unavailable offline for this verse]`);
      lines.push('');
      if (opts.lexWords.length) {
        lines.push(`Major ${langName} words that shape this verse (Roman spelling):`);
        opts.lexWords.forEach((w) => {
          lines.push(formatLexWordLine(w));
        });
        lines.push('');
        const glosses = opts.lexWords
          .map((w) => `${w.translit} ("${w.gloss}")`)
          .join(', ');
        lines.push(`How these words build the verse: the English "${opts.english}" rests on ${langName} terms such as ${glosses}. Each word above carries part of the verse's meaning in its original language.`);
      } else {
        lines.push(`No major ${langName} lexicon matches were found for this verse yet. The full ${langName} text above is from the offline Bible cache.`);
      }
      return lines.join('\n');
    }

    async function showVerseStudyPanel(verseEl, block, panelType, book, chapterNum, payload) {
      const expand = verseEl.querySelector('.library-verse-expand');
      if (!expand) return;

      const btn = verseEl.querySelector(`.verse-study-btn[data-panel="${panelType}"]`);
      const isOpen = !expand.hidden && expand.dataset.panel === panelType;

      verseEl.querySelectorAll('.verse-study-btn').forEach((b) => b.classList.remove('active'));
      if (isOpen) {
        expand.hidden = true;
        expand.dataset.panel = '';
        return;
      }

      expand.hidden = false;
      expand.dataset.panel = panelType;
      if (btn) btn.classList.add('active');
      expand.innerHTML = '<div class="library-expand-label">Loading…</div><div class="library-expand-body">Preparing offline study notes…</div>';

      try {
        await loadStudyLexicon();
        const isNT = NT_BOOK_CODES.has(book.code);
        const ref = `${payload.bookName} ${chapterNum}:${block.number}`;
        const originals = await fetchOriginalVerseTexts(book.code, chapterNum, block.number, isNT);
        const heading = findSectionHeading(libraryChapterVerses, block.number);
        const { prev, next } = getNeighborVerses(libraryChapterVerses, block.number, payload.bookName, chapterNum);

        const lang = isNT ? 'greek' : 'hebrew';
        const langLabel = isNT ? 'Greek' : 'Hebrew';
        let body = '';
        if (panelType === 'context') {
          const lexWords = lookupLexiconWords(originals.originalText, lang);
          body = buildContextExplanation({
            ref,
            english: block.text,
            translationShort: getLibraryTranslationInfo().short,
            originalText: originals.originalText,
            originalLabel: originals.originalLabel,
            heading,
            prev,
            next,
            lexWords,
            isNT
          });
        } else {
          const lexWords = lookupLexiconWords(originals.originalText, lang);
          body = buildOriginalWordsExplanation({
            originalText: originals.originalText,
            originalLabel: originals.originalLabel,
            lang,
            lexWords,
            english: block.text
          });
        }

        expand.innerHTML =
          `<div class="library-expand-label">${panelType === 'context' ? 'Context' : langLabel}</div>` +
          `<div class="library-expand-body">${body.replace(/</g, '&lt;').replace(/>/g, '&gt;')}</div>`;
      } catch (err) {
        expand.innerHTML =
          `<div class="library-expand-label">Error</div>` +
          `<div class="library-expand-body">Could not load offline study data. Open Library once while online to cache Bible and lexicon files.\n\n${err.message || err}</div>`;
      }
    }

    function askJohnAboutVerse(ref, englishText) {
      if (!navigator.onLine) {
        alert('Ask AI, John needs an internet connection.');
        return;
      }
      switchMainView('chat');
      const trans = getLibraryTranslationInfo();
      const prompt = `Please discuss ${ref} (${trans.short}): "${englishText}". Explain the surrounding context and the key Greek or Hebrew words and how they deepen our understanding of the English translation.`;
      userInput.value = prompt;
      userInput.focus();
      sendToGrok(prompt);
    }

    async function loadOfflineBibleComplete(transId) {
      const id = transId || getLibraryTranslationId();
      if (offlineBibleCompleteByTrans[id]) return offlineBibleCompleteByTrans[id];
      if (offlineBibleLoadPromises[id]) return offlineBibleLoadPromises[id];

      offlineBibleLoadPromises[id] = (async () => {
        const url = `${BIBLE_API_ORIGIN}/api/${id}/complete.json`;
        const res = await fetch(url);
        if (!res.ok) throw new Error(`Bible data unavailable (${res.status})`);
        const data = await res.json();
        if (!data || !Array.isArray(data.books)) throw new Error('Invalid Bible data');
        offlineBibleCompleteByTrans[id] = data;
        return data;
      })();

      try {
        return await offlineBibleLoadPromises[id];
      } catch (err) {
        delete offlineBibleLoadPromises[id];
        throw err;
      }
    }

    async function fetchLibraryChapter(bookCode, chapterNum) {
      try {
        const complete = await loadOfflineBibleComplete();
        const book = complete.books.find((b) => b.id === bookCode);
        if (book && Array.isArray(book.chapters)) {
          const entry = book.chapters.find((c) => c.chapter && c.chapter.number === chapterNum);
          if (entry && entry.chapter) {
            return {
              bookName: book.commonName || book.name || bookCode,
              translation: complete.translation?.englishName || getLibraryTranslationInfo().name,
              chapter: entry.chapter
            };
          }
        }
      } catch (e) {
        console.warn('[Library] complete.json lookup failed, trying chapter file:', e);
      }

      const chapterUrl = `${BIBLE_API_ORIGIN}/api/${getLibraryTranslationId()}/${bookCode}/${chapterNum}.json`;
      const res = await fetch(chapterUrl);
      if (!res.ok) throw new Error(`Chapter unavailable offline (${res.status})`);
      const data = await res.json();
      if (!data || !data.chapter) throw new Error('Invalid chapter data');
      return {
        bookName: data.book?.commonName || data.book?.name || bookCode,
        translation: data.translation?.englishName || getLibraryTranslationInfo().name,
        chapter: data.chapter
      };
    }

    function setLibrarySearchVisible(visible) {
      const search = document.getElementById('library-search');
      if (search) search.style.display = visible ? 'block' : 'none';
    }

    function setLibraryTransVisible(visible) {
      const row = document.getElementById('library-trans-row');
      if (row) row.style.display = visible ? 'flex' : 'none';
    }

    function updateLibraryBackButton() {
      const backBtn = document.getElementById('library-back-btn');
      if (!backBtn) return;
      if (libraryView === 'books') {
        backBtn.style.display = 'none';
      } else {
        backBtn.style.display = 'inline-block';
        backBtn.textContent = libraryView === 'chapters' ? '← Books' : '← Chapters';
      }
    }

    function libraryNavigateBack() {
      const search = document.getElementById('library-search');
      if (libraryView === 'verses' && librarySelectedBook) {
        renderLibraryChapters(librarySelectedBook);
        return;
      }
      renderLibraryBooks(search?.value || '');
    }

    function renderLibrarySection(title, books, filter) {
      const q = (filter || '').trim().toLowerCase();
      const filtered = q
        ? books.filter((b) => b.name.toLowerCase().includes(q))
        : books;
      if (!filtered.length) return '';

      const buttons = filtered.map((book) =>
        `<button type="button" class="library-book-btn" data-book-code="${book.code}">${book.name}</button>`
      ).join('');

      return `<div class="library-section-title">${title}</div><div class="library-books-grid">${buttons}</div>`;
    }

    function renderLibraryBooks(filter) {
      const container = document.getElementById('library-books-view');
      const chaptersView = document.getElementById('library-chapters-view');
      const versesView = document.getElementById('library-verses-view');
      const titleEl = document.getElementById('library-view-title');
      if (!container) return;

      libraryView = 'books';
      librarySelectedBook = null;
      librarySelectedChapter = null;
      if (chaptersView) chaptersView.style.display = 'none';
      if (versesView) versesView.style.display = 'none';
      container.style.display = 'block';
      setLibrarySearchVisible(true);
      setLibraryTransVisible(true);
      updateLibraryBackButton();
      if (titleEl) titleEl.textContent = 'Bible Library';
      updateLibraryMeta();

      container.innerHTML =
        renderLibrarySection('Old Testament', BIBLE_LIBRARY.ot, filter) +
        renderLibrarySection('New Testament', BIBLE_LIBRARY.nt, filter);

      container.querySelectorAll('.library-book-btn').forEach((btn) => {
        btn.addEventListener('click', () => {
          const code = btn.getAttribute('data-book-code');
          const book = [...BIBLE_LIBRARY.ot, ...BIBLE_LIBRARY.nt].find((b) => b.code === code);
          if (book) renderLibraryChapters(book);
        });
      });
    }

    function renderLibraryChapters(book) {
      const container = document.getElementById('library-books-view');
      const chaptersView = document.getElementById('library-chapters-view');
      const versesView = document.getElementById('library-verses-view');
      const titleEl = document.getElementById('library-view-title');
      if (!chaptersView || !container) return;

      libraryView = 'chapters';
      librarySelectedBook = book;
      librarySelectedChapter = null;
      container.style.display = 'none';
      if (versesView) versesView.style.display = 'none';
      chaptersView.style.display = 'block';
      setLibrarySearchVisible(false);
      setLibraryTransVisible(true);
      updateLibraryBackButton();
      if (titleEl) titleEl.textContent = book.name;

      const chapterButtons = Array.from({ length: book.chapters }, (_, i) => {
        const ch = i + 1;
        return `<button type="button" class="library-chapter-btn" data-chapter="${ch}">${ch}</button>`;
      }).join('');

      chaptersView.innerHTML = `<div class="library-chapters-grid">${chapterButtons}</div>`;
      chaptersView.querySelectorAll('.library-chapter-btn').forEach((btn) => {
        btn.addEventListener('click', () => {
          const chapter = parseInt(btn.getAttribute('data-chapter'), 10);
          renderLibraryVerses(book, chapter);
        });
      });
    }

    async function renderLibraryVerses(book, chapterNum) {
      const container = document.getElementById('library-books-view');
      const chaptersView = document.getElementById('library-chapters-view');
      const versesView = document.getElementById('library-verses-view');
      const titleEl = document.getElementById('library-view-title');
      if (!versesView || !container || !chaptersView) return;

      libraryView = 'verses';
      librarySelectedBook = book;
      librarySelectedChapter = chapterNum;
      container.style.display = 'none';
      chaptersView.style.display = 'none';
      versesView.style.display = 'block';
      setLibrarySearchVisible(false);
      setLibraryTransVisible(true);
      updateLibraryBackButton();
      if (titleEl) {
        titleEl.textContent = `${book.name} ${chapterNum}`;
      }

      versesView.innerHTML = '<div class="library-loading">Loading chapter…</div>';

      try {
        const payload = await fetchLibraryChapter(book.code, chapterNum);
        const blocks = parseChapterContent(payload.chapter.content);
        libraryChapterVerses = blocks.slice();
        if (!blocks.length) {
          versesView.innerHTML = '<div class="library-error">No verses found in this chapter.</div>';
          return;
        }

        const wrapper = document.createElement('div');
        wrapper.className = 'library-verses';

        const studyBtn = document.createElement('button');
        studyBtn.type = 'button';
        studyBtn.className = 'library-study-btn';
        studyBtn.textContent = 'Study with AI →';
        studyBtn.disabled = !navigator.onLine;
        studyBtn.title = navigator.onLine
          ? 'Open this chapter in Chat for AI study'
          : 'AI study needs internet';
        studyBtn.addEventListener('click', () => studyFromLibrary(book.name, chapterNum));
        if (titleEl) {
          titleEl.innerHTML = '';
          titleEl.appendChild(document.createTextNode(`${book.name} ${chapterNum}`));
          titleEl.appendChild(studyBtn);
        }

        blocks.forEach((block) => {
          if (block.type === 'heading') {
            const h = document.createElement('div');
            h.className = 'library-heading';
            h.textContent = block.text;
            wrapper.appendChild(h);
            return;
          }

          const ref = `${payload.bookName} ${chapterNum}:${block.number}`;
          const verseEl = document.createElement('div');
          verseEl.className = 'library-verse';

          const num = document.createElement('span');
          num.className = 'library-verse-num';
          num.textContent = block.number;
          verseEl.appendChild(num);

          const text = document.createElement('span');
          text.textContent = block.text;
          verseEl.appendChild(text);

          const actions = document.createElement('div');
          actions.className = 'library-verse-actions';

          const source = {
            reference: ref,
            translation: payload.translation,
            text: block.text
          };

          const speakBtn = document.createElement('button');
          speakBtn.type = 'button';
          speakBtn.className = 'verse-speak-btn';
          speakBtn.textContent = '🔊 Speak';
          speakBtn.addEventListener('click', () => speak(formatVerseCitation(source), null, getLibrarySpeakLangBcp47()));
          actions.appendChild(speakBtn);

          const shareBtn = document.createElement('button');
          shareBtn.type = 'button';
          shareBtn.className = 'verse-share-btn';
          shareBtn.textContent = 'Share';
          shareBtn.title = 'Share verse to social apps';
          shareBtn.addEventListener('click', () => shareVerseCitation(source, shareBtn));
          actions.appendChild(shareBtn);

          const isNT = NT_BOOK_CODES.has(book.code);
          const langPanel = isNT ? 'greek' : 'hebrew';
          const langName = isNT ? 'Greek' : 'Hebrew';

          const contextBtn = document.createElement('button');
          contextBtn.type = 'button';
          contextBtn.className = 'verse-study-btn';
          contextBtn.dataset.panel = 'context';
          contextBtn.textContent = 'Context';
          contextBtn.title = `Context from the original ${langName} (offline)`;
          contextBtn.addEventListener('click', () => {
            showVerseStudyPanel(verseEl, block, 'context', book, chapterNum, payload);
          });
          actions.appendChild(contextBtn);

          const langBtn = document.createElement('button');
          langBtn.type = 'button';
          langBtn.className = 'verse-study-btn';
          langBtn.dataset.panel = langPanel;
          langBtn.textContent = langName;
          langBtn.title = isNT
            ? 'Greek word study from SBL (offline)'
            : 'Hebrew word study from Westminster Leningrad Codex (offline)';
          langBtn.addEventListener('click', () => {
            showVerseStudyPanel(verseEl, block, langPanel, book, chapterNum, payload);
          });
          actions.appendChild(langBtn);

          const askBtn = document.createElement('button');
          askBtn.type = 'button';
          askBtn.className = 'verse-study-btn';
          askBtn.textContent = 'Ask AI, John';
          askBtn.disabled = !navigator.onLine;
          askBtn.title = navigator.onLine
            ? 'Discuss this verse with AI, John in Chat'
            : 'Ask AI, John needs internet';
          askBtn.addEventListener('click', () => askJohnAboutVerse(ref, block.text));
          actions.appendChild(askBtn);

          const expandEl = document.createElement('div');
          expandEl.className = 'library-verse-expand';
          expandEl.hidden = true;

          verseEl.appendChild(actions);
          verseEl.appendChild(expandEl);
          wrapper.appendChild(verseEl);
        });

        versesView.innerHTML = '';
        versesView.appendChild(wrapper);
      } catch (err) {
        versesView.innerHTML = `<div class="library-error">Could not load this chapter offline yet. Visit Library once while online so the Bible cache can download.<br><br><small>${err.message || err}</small></div>`;
      }
    }

    function studyFromLibrary(bookName, chapter) {
      if (!navigator.onLine) return;
      switchMainView('chat');
      const prompt = `Please walk me through ${bookName} chapter ${chapter}.`;
      userInput.value = prompt;
      userInput.focus();
      sendToGrok(prompt);
    }

    function initLibrary() {
      const search = document.getElementById('library-search');
      const backBtn = document.getElementById('library-back-btn');
      if (search) {
        search.addEventListener('input', () => {
          if (libraryView === 'books') renderLibraryBooks(search.value);
        });
      }
      if (backBtn) {
        backBtn.addEventListener('click', libraryNavigateBack);
      }
      window.addEventListener('online', () => {
        updateLibraryMeta();
        document.querySelectorAll('.library-verse .verse-study-btn').forEach((btn) => {
          if (btn.textContent === 'Ask AI, John') {
            btn.disabled = false;
            btn.title = 'Discuss this verse with AI, John in Chat';
          }
        });
        const studyHdr = document.querySelector('.library-study-btn');
        if (studyHdr) studyHdr.disabled = false;
      });
      window.addEventListener('offline', () => {
        updateLibraryMeta();
        document.querySelectorAll('.library-verse .verse-study-btn').forEach((btn) => {
          if (btn.textContent === 'Ask AI, John') {
            btn.disabled = true;
            btn.title = 'Ask AI, John needs internet';
          }
        });
        const studyHdr = document.querySelector('.library-study-btn');
        if (studyHdr) studyHdr.disabled = true;
      });
      initLibraryLanguageSettings();
      initLibraryTranslationSelector();
      refreshLibraryLanguageUI().then(() => {
        preloadOfflineBible();
        renderLibraryBooks('');
      });
    }

    function formatVerseCitation(source) {
      const ref = (source.reference || '').trim();
      const trans = (source.translation || '').trim();
      const text = (source.text || '').trim();
      if (!text) return `${ref} (${trans})`;
      return `"${text}" — ${ref} (${trans})`;
    }

    function formatConversationShareText(question, reply) {
      const q = (question || '').trim();
      const r = (reply || '').trim();
      let text = '';
      if (q) text += `Q: ${q}\n\n`;
      text += `AI: ${r}`;
      return text;
    }

    function appendShareLink(bodyText, sharePageUrl) {
      const link = productionShareUrl(sharePageUrl || SITE_SHARE_URL);
      // Plain text only (no HTML) so paste into Messages/SMS shows readable verses + link.
      return `${String(bodyText || '').trim()}\n\n— The Word in Context\n${link}`;
    }

    async function createShareRecord(payload) {
      const res = await fetch('/api/share', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (!res.ok) throw new Error('Share create failed');
      return res.json();
    }

    function formatSharePayload(payload) {
      let bodyText = '';
      let title = 'The Word in Context';
      let apiPayload = null;

      if (payload.type === 'verse' && payload.source) {
        const source = payload.source;
        bodyText = formatVerseCitation(source);
        title = (source.reference || '').trim() || 'Scripture';
        apiPayload = {
          type: 'verse',
          reference: source.reference || '',
          translation: source.translation || '',
          text: source.text || '',
        };
      } else if (payload.type === 'conversation') {
        bodyText = formatConversationShareText(payload.question, payload.reply);
        title = (payload.question || '').trim().slice(0, 80) || 'Study with AI';
        apiPayload = {
          type: 'conversation',
          question: payload.question || '',
          reply: payload.reply || '',
        };
      }

      return {
        title,
        bodyText,
        apiPayload,
        textWithLink: appendShareLink(bodyText, SITE_SHARE_URL),
      };
    }

    async function buildShareContent(payload) {
      const base = formatSharePayload(payload);
      let sharePageUrl = SITE_SHARE_URL;
      if (base.apiPayload) {
        try {
          const data = await createShareRecord(base.apiPayload);
          if (data && data.url) sharePageUrl = data.url;
        } catch (e) {}
      }
      sharePageUrl = productionShareUrl(sharePageUrl);
      return {
        title: base.title,
        bodyText: base.bodyText,
        sharePageUrl,
        textWithLink: appendShareLink(base.bodyText, sharePageUrl),
      };
    }

    let verseShareMenuCloseHandler = null;

    function closeVerseShareMenu() {
      const menu = document.getElementById('verse-share-menu');
      const backdrop = document.getElementById('verse-share-backdrop');
      if (menu) menu.remove();
      if (backdrop) backdrop.remove();
      if (verseShareMenuCloseHandler) {
        document.removeEventListener('keydown', verseShareMenuCloseHandler);
        verseShareMenuCloseHandler = null;
      }
    }

    function positionVerseShareMenu(menu, anchorEl) {
      const rect = anchorEl.getBoundingClientRect();
      const margin = 8;
      menu.style.visibility = 'hidden';
      menu.style.left = '0';
      menu.style.top = '0';
      document.body.appendChild(menu);
      const menuRect = menu.getBoundingClientRect();
      let left = rect.left;
      let top = rect.bottom + margin;
      if (left + menuRect.width > window.innerWidth - margin) {
        left = window.innerWidth - menuRect.width - margin;
      }
      if (left < margin) left = margin;
      if (top + menuRect.height > window.innerHeight - margin) {
        top = rect.top - menuRect.height - margin;
      }
      if (top < margin) top = margin;
      menu.style.left = `${left}px`;
      menu.style.top = `${top}px`;
      menu.style.visibility = 'visible';
    }

    async function copyShareText(text, btn) {
      // Always plain text — never text/html — so iMessage/SMS does not paste “code”.
      const plain = String(text || '').replace(/\r\n/g, '\n');
      let copied = false;
      try {
        if (navigator.clipboard && navigator.clipboard.writeText) {
          await navigator.clipboard.writeText(plain);
          copied = true;
        }
      } catch (e) {}

      if (!copied) {
        const ta = document.createElement('textarea');
        ta.value = plain;
        ta.setAttribute('readonly', '');
        ta.style.cssText = 'position:fixed;left:-9999px;top:0;opacity:0;';
        document.body.appendChild(ta);
        ta.focus();
        ta.select();
        ta.setSelectionRange(0, plain.length);
        try {
          copied = document.execCommand('copy');
        } catch (e) {}
        ta.remove();
      }

      if (btn) {
        const original = btn.textContent;
        btn.textContent = copied ? 'Copied!' : 'Copy failed';
        btn.classList.toggle('copied', copied);
        setTimeout(() => {
          btn.textContent = original;
          btn.classList.remove('copied');
        }, 1600);
      }
      return copied;
    }

    async function copyVerseCitation(source, btn) {
      const content = await buildShareContent({ type: 'verse', source });
      return copyShareText(content.textWithLink, btn);
    }

    let shareToastTimer = null;

    function showShareToast(title, message) {
      const existing = document.getElementById('share-toast');
      if (existing) existing.remove();
      if (shareToastTimer) clearTimeout(shareToastTimer);

      const toast = document.createElement('div');
      toast.id = 'share-toast';
      toast.className = 'share-toast';
      toast.setAttribute('role', 'status');
      toast.innerHTML = `<strong>${title}</strong><span>${message}</span>`;
      document.body.appendChild(toast);

      shareToastTimer = setTimeout(() => {
        toast.remove();
        shareToastTimer = null;
      }, 9000);
    }

    function isMobileShareDevice() {
      return /iPhone|iPad|iPod|Android/i.test(navigator.userAgent)
        || (window.matchMedia && window.matchMedia('(max-width: 768px)').matches);
    }

    function openExternalShare(url) {
      const a = document.createElement('a');
      a.href = url;
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
      document.body.appendChild(a);
      a.click();
      a.remove();
    }

    function isLocalShareUrl(url) {
      return /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?/i.test(url || '');
    }

    function productionShareUrl(url) {
      if (!url || isLocalShareUrl(url)) return 'https://www.thewordincontext.org';
      return url
        .replace(/^http:\/\//i, 'https://')
        .replace(/:\/\/word-in-context\.onrender\.com/i, '://www.thewordincontext.org');
    }

    function closeFacebookShareModal() {
      const modal = document.getElementById('facebook-share-modal');
      if (modal) modal.remove();
    }

    function copyFromTextarea(ta) {
      if (!ta) return false;
      ta.focus();
      ta.select();
      ta.setSelectionRange(0, ta.value.length);
      try {
        return document.execCommand('copy');
      } catch (e) {
        return false;
      }
    }

    async function copyShareTextSync(text) {
      try {
        if (navigator.clipboard && navigator.clipboard.writeText) {
          await navigator.clipboard.writeText(text);
          return true;
        }
      } catch (e) {}
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.left = '-9999px';
      document.body.appendChild(ta);
      ta.focus();
      ta.select();
      ta.setSelectionRange(0, ta.value.length);
      let copied = false;
      try {
        copied = document.execCommand('copy');
      } catch (e) {}
      ta.remove();
      return copied;
    }

    function showFacebookShareModal(payload, preparedContent) {
      closeFacebookShareModal();
      const base = formatSharePayload(payload);
      const mobile = isMobileShareDevice();
      const initialContent = preparedContent || {
        sharePageUrl: SITE_SHARE_URL,
        textWithLink: base.textWithLink,
      };

      const backdrop = document.createElement('div');
      backdrop.id = 'facebook-share-modal';
      backdrop.className = 'modal';
      backdrop.style.display = 'flex';

      const panel = document.createElement('div');
      panel.className = 'modal-content';
      panel.innerHTML = `
        <h3>Share on Facebook</h3>
        <p class="fb-share-note">Facebook won't type your message for you — only a link preview. Your full text is copied below; paste it into the post after you open Facebook.</p>
        <div class="fb-share-status" id="fb-share-status">Copying…</div>
        <textarea class="fb-share-text" id="fb-share-text" readonly aria-label="Message to share"></textarea>
        <ol class="fb-share-steps">
          <li>Confirm the text above looks right</li>
          <li>Tap <strong>Open Facebook</strong> (copies again)</li>
          <li>In Facebook, tap the post box → <strong>Paste</strong></li>
        </ol>
        <div class="fb-share-actions">
          <button type="button" class="fb-open-btn" id="fb-open-btn">Open Facebook</button>
          <button type="button" class="fb-copy-btn" id="fb-copy-btn">Copy again</button>
          <button type="button" class="fb-close-btn" id="fb-close-btn">Close</button>
        </div>
      `;

      backdrop.appendChild(panel);
      backdrop.addEventListener('click', (e) => {
        if (e.target === backdrop) closeFacebookShareModal();
      });
      document.body.appendChild(backdrop);

      const ta = panel.querySelector('#fb-share-text');
      const status = panel.querySelector('#fb-share-status');
      const openBtn = panel.querySelector('#fb-open-btn');
      const copyBtn = panel.querySelector('#fb-copy-btn');
      const closeBtn = panel.querySelector('#fb-close-btn');

      let sharePageUrl = productionShareUrl(initialContent.sharePageUrl);
      let shareText = initialContent.textWithLink.replace(
        initialContent.sharePageUrl,
        sharePageUrl,
      );

      const refreshCopyStatus = async () => {
        ta.value = shareText;
        let copied = await copyShareTextSync(shareText);
        if (!copied) copied = copyFromTextarea(ta);
        status.textContent = copied ? 'Copied to clipboard ✓' : 'Tap Copy again or select all text';
        status.classList.toggle('failed', !copied);
        return copied;
      };

      refreshCopyStatus();

      copyBtn.addEventListener('click', () => { refreshCopyStatus(); });
      closeBtn.addEventListener('click', closeFacebookShareModal);
      openBtn.addEventListener('click', async () => {
        await refreshCopyStatus();
        const publicUrl = productionShareUrl(sharePageUrl);
        const fbUrl = mobile
          ? `https://m.facebook.com/sharer.php?u=${encodeURIComponent(publicUrl)}`
          : `https://www.facebook.com/sharer/sharer.php?u=${encodeURIComponent(publicUrl)}`;
        openExternalShare(fbUrl);
      });
    }

    function attachAssistantMessageActions(msgEl, reply, userQuestion) {
      const actionRow = document.createElement('div');
      actionRow.className = 'message-action-row';

      const shareBtn = document.createElement('button');
      shareBtn.type = 'button';
      shareBtn.className = 'message-share-btn';
      shareBtn.textContent = 'Share';
      shareBtn.title = 'Share question and AI reply';
      shareBtn.addEventListener('click', () => openShareMenu({
        type: 'conversation',
        question: userQuestion,
        reply,
      }, shareBtn));
      actionRow.appendChild(shareBtn);

      const speakBtn = document.createElement('button');
      speakBtn.className = 'speak-btn';
      speakBtn.textContent = '🔊';
      speakBtn.title = 'Speak reply';
      speakBtn.onclick = () => speak(reply);
      actionRow.appendChild(speakBtn);

      msgEl.appendChild(actionRow);
    }

    function openShareMenu(payload, anchorEl) {
      closeVerseShareMenu();
      const menuTitle = payload.type === 'conversation' ? 'Share study' : 'Share verse';

      const backdrop = document.createElement('div');
      backdrop.id = 'verse-share-backdrop';
      backdrop.className = 'verse-share-backdrop';
      backdrop.addEventListener('click', closeVerseShareMenu);

      const menu = document.createElement('div');
      menu.id = 'verse-share-menu';
      menu.className = 'verse-share-menu';
      menu.setAttribute('role', 'menu');
      menu.innerHTML = `<div class="verse-share-menu-title">${menuTitle}</div>`;

      const addItem = (label, icon, onClick) => {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'verse-share-menu-item';
        btn.setAttribute('role', 'menuitem');
        btn.innerHTML = `<span class="share-icon" aria-hidden="true">${icon}</span><span>${label}</span>`;
        btn.addEventListener('click', async (e) => {
          e.stopPropagation();
          closeVerseShareMenu();
          await onClick();
        });
        menu.appendChild(btn);
      };

      if (navigator.share) {
        addItem('Messages / Apps…', '📤', async () => {
          try {
            const content = await buildShareContent(payload);
            // Plain text only. Passing both `text` (already includes the URL) and
            // a separate `url` makes iOS Messages show broken “code” or duplicate links.
            await navigator.share({
              title: content.title,
              text: content.textWithLink,
            });
          } catch (e) {
            if (e && e.name !== 'AbortError') {
              const content = await buildShareContent(payload);
              await copyShareText(content.textWithLink, anchorEl);
            }
          }
        });
      }

      addItem('Facebook', 'f', async () => {
        const content = await buildShareContent(payload);
        showFacebookShareModal(payload, content);
      });

      addItem('X (Twitter)', '𝕏', async () => {
        const content = await buildShareContent(payload);
        openExternalShare(`https://twitter.com/intent/tweet?text=${encodeURIComponent(content.textWithLink)}`);
      });

      addItem('WhatsApp', '💬', async () => {
        const content = await buildShareContent(payload);
        openExternalShare(`https://wa.me/?text=${encodeURIComponent(content.textWithLink)}`);
      });

      addItem('Email', '✉️', async () => {
        const content = await buildShareContent(payload);
        window.location.href = `mailto:?subject=${encodeURIComponent(content.title)}&body=${encodeURIComponent(content.textWithLink)}`;
      });

      addItem('Copy text', '📋', async () => {
        const content = await buildShareContent(payload);
        await copyShareText(content.textWithLink, anchorEl);
      });

      document.body.appendChild(backdrop);
      positionVerseShareMenu(menu, anchorEl);

      verseShareMenuCloseHandler = (e) => {
        if (e.key === 'Escape') closeVerseShareMenu();
      };
      document.addEventListener('keydown', verseShareMenuCloseHandler);
    }

    function shareVerseCitation(source, anchorEl) {
      openShareMenu({ type: 'verse', source }, anchorEl);
    }

    function getDefaultEnglishTrans() {
      let saved = localStorage.getItem('default_english_trans') || 'BSB';
      if (saved === 'eng_lsv' || !ALLOWED_ENGLISH_TRANS.has(saved)) {
        saved = 'BSB';
        localStorage.setItem('default_english_trans', saved);
      }
      return saved;
    }

    // ====================== HELPERS ======================
    function addMessage(text, isUser, isLoading = false) {
      const div = document.createElement('div');
      div.className = `message ${isUser ? 'user' : 'ai'}`;
      div.textContent = text;
      if (isLoading) div.dataset.loading = 'true';

      messagesContainer.appendChild(div);
      messagesContainer.scrollTop = messagesContainer.scrollHeight;
      return div;
    }

    function removeLoadingMessage() {
      const loading = messagesContainer.querySelector('[data-loading="true"]');
      if (loading) loading.remove();
    }

    // Attach a clickable "Sources (live...)" line under AI messages.
    // Shows the references; click reveals the exact live-fetched verse text + share/speak per verse.
    function attachSourcesUI(msgEl, sources, fullReplyForSpeak) {
      if (!sources || !sources.length) return;

      const wrap = document.createElement('div');
      wrap.className = 'scripture-sources';

      const label = document.createElement('span');
      label.className = 'label';
      label.textContent = 'Sources (live from bible.helloao.org): ';
      wrap.appendChild(label);

      sources.forEach((s, idx) => {
        if (idx > 0) wrap.appendChild(document.createTextNode(' · '));

        const refSpan = document.createElement('span');
        refSpan.className = 'ref';
        const ref = (s.reference || '').trim();
        const trans = (s.translation || '').trim();
        refSpan.textContent = `${ref} (${trans})`;
        wrap.appendChild(refSpan);

        const shareInline = document.createElement('button');
        shareInline.type = 'button';
        shareInline.className = 'ref-share-btn';
        shareInline.title = 'Copy verse with citation';
        shareInline.setAttribute('aria-label', `Share ${ref}`);
        shareInline.textContent = 'Share';
        shareInline.addEventListener('click', (ev) => {
          ev.stopImmediatePropagation();
          shareVerseCitation(s, shareInline);
        });
        wrap.appendChild(shareInline);
      });

      wrap.title = 'Click to view exact verse text fetched live for this answer';

      wrap.addEventListener('click', (e) => {
        if (e.target.closest('.ref-share-btn')) return;
        e.stopImmediatePropagation();

        let box = msgEl.querySelector('.sources-detail');
        if (box) {
          box.remove();
          return;
        }

        box = document.createElement('div');
        box.className = 'sources-detail';
        box.style.cssText = 'margin-top:6px; font-size:11.5px; line-height:1.4; background:var(--bg-sources-detail); padding:8px; border-radius:6px; border:1px solid var(--border-soft);';

        sources.forEach((s) => {
          const block = document.createElement('div');
          block.className = 'verse-block';

          const refLine = document.createElement('div');
          refLine.className = 'verse-ref';
          refLine.textContent = `${s.reference} (${s.translation})`;
          block.appendChild(refLine);

          const textLine = document.createElement('div');
          textLine.className = 'verse-text';
          textLine.textContent = s.text || '';
          block.appendChild(textLine);

          const actions = document.createElement('div');
          actions.className = 'verse-actions';

          const shareBtn = document.createElement('button');
          shareBtn.type = 'button';
          shareBtn.className = 'verse-share-btn';
          shareBtn.textContent = 'Share';
          shareBtn.title = 'Share verse to social apps';
          shareBtn.addEventListener('click', (ev) => {
            ev.stopImmediatePropagation();
            shareVerseCitation(s, shareBtn);
          });
          actions.appendChild(shareBtn);

          const speakBtn = document.createElement('button');
          speakBtn.type = 'button';
          speakBtn.className = 'verse-speak-btn';
          speakBtn.textContent = '🔊 Speak';
          speakBtn.addEventListener('click', (ev) => {
            ev.stopImmediatePropagation();
            speak(formatVerseCitation(s));
          });
          actions.appendChild(speakBtn);

          block.appendChild(actions);
          box.appendChild(block);
        });

        const speakAll = document.createElement('button');
        speakAll.type = 'button';
        speakAll.textContent = '🔊 Speak all verses';
        speakAll.className = 'verse-speak-btn';
        speakAll.style.marginTop = '8px';
        speakAll.addEventListener('click', (ev) => {
          ev.stopImmediatePropagation();
          speak(sources.map((s) => formatVerseCitation(s)).join('\n\n'));
        });
        box.appendChild(speakAll);

        wrap.after(box);
      });

      msgEl.appendChild(wrap);
    }

    // Fully free the OS audio session for TTS playback.
    // iOS Safari (and Chrome on iPhone) will often play no audio from speechSynthesis while
    // SpeechRecognition and/or getUserMedia tracks are still live. Desktop Chrome tolerates
    // concurrent mic + TTS; mobile WebKit does not. Barge-in while AI is speaking is via the
    // mic / Stop button after this release (wake-word barge-in resumes after speech ends).
    function isMicHardwareLive() {
      return !!(isListening || startingRecognition
        || (mediaRecorder && mediaRecorder.state !== 'inactive')
        || mediaStream);
    }

    function releaseMicForSpeechOutput() {
      const hadLiveMic = isMicHardwareLive();
      // Typed questions (and replies after Thinking) must not abort an idle
      // recognizer — abort() still flips the audio session and delays TTS.
      if (!hadLiveMic) return false;
      justReleasedLiveMic = true;

      if (restartTimer) {
        clearTimeout(restartTimer);
        restartTimer = null;
      }
      if (commitTimeout) {
        clearTimeout(commitTimeout);
        commitTimeout = null;
      }
      if (liveSttTimer) {
        clearTimeout(liveSttTimer);
        liveSttTimer = null;
      }

      stopListeningUI();

      if (mediaRecorder) {
        try {
          if (mediaRecorder.state !== 'inactive') mediaRecorder.stop();
        } catch (e) {}
        try {
          mediaRecorder.ondataavailable = null;
          mediaRecorder.onstop = null;
        } catch (e) {}
        mediaRecorder = null;
      }

      if (mediaStream) {
        try {
          mediaStream.getTracks().forEach((track) => {
            try { track.stop(); } catch (e) {}
          });
        } catch (e) {}
        mediaStream = null;
      }

      if (recognition) {
        try {
          recognition.abort();
        } catch (e) {
          try { recognition.stop(); } catch (e2) {}
        }
      }
      return true;
    }

    function speak(text, voiceNoteEl = null, langHint = null) {
      const voiceHint = selectedVoice
        || (voiceSettings.voiceId ? findLocalVoiceById(voiceSettings.voiceId) : null);
      text = cleanTextForSpeech(text, voiceHint);
      // Cancel only OUR in-flight speech. Chrome/WebKit delay or drop the next
      // utterance after cancel(), which looks like the old post-answer pause.
      // synth.speaking / synth.pending also stick true after wakeSpeechEngine
      // or a prior cancel — do not treat those flags as "we must cancel".
      const interrupting = !!(currentUtterance && !currentUtterance.__isUnlock)
        || (speechQueue.length > 0 && speechQueueIndex > 0 && speechQueueIndex < speechQueue.length)
        || (hostedAudio && !hostedAudio.paused);
      resetSpeechQueue();
      if (interrupting) {
        try { synth.cancel(); } catch (e) {}
      }
      currentUtterance = null;
      if (hostedAudio) {
        try { hostedAudio.pause(); hostedAudio.currentTime = 0; } catch (e) {}
        hostedAudio = null;
      }
      if (restartTimer) {
        clearTimeout(restartTimer);
        restartTimer = null;
      }

      // Block hands-free mic restart until speech finishes (finishSpeechOutput) or user stops.
      if (handsFreeEnabled) isAwaitingResponse = true;

      // First sentence only — remaining sentences are queued AFTER synth.speak()
      // so a long reply cannot block the main thread before audio starts.
      lastSpokenText = text;
      const firstChunk = takeFirstSpeechChunk(text);
      speechQueue = firstChunk ? [firstChunk] : [];
      speechQueueIndex = 0;

      // Only flip the audio session if capture is still live. sendToGrok already
      // released the mic during Thinking, so typed replies should hit this as false.
      const releasedLiveMic = releaseMicForSpeechOutput();

      // Prime the speech synthesis engine immediately (Mac requires recent getVoices() + gesture context for non-default voices to work reliably)
      try { synth.getVoices(); } catch (e) {}
      try { if (synth.paused) synth.resume(); } catch (e) {}

      // Always use fast local system voices. We no longer support cloud/XAI voices
      // because good local neural voices (especially after installing via Piper etc.) sound better
      // and have zero lag.
      if (voiceSettings.voiceSource !== 'local') {
        voiceSettings.voiceSource = 'local';
        localStorage.setItem('voice_source', 'local');
      }
      // Re-resolve the selected voice object right now so fallbackToBrowserSpeech uses the
      // user's chosen local voice (e.g. the English male from the dropdown).
      if (voiceSettings.voiceSource === 'local' && voiceSettings.voiceId) {
        const resolved = findLocalVoiceById(voiceSettings.voiceId);
        if (resolved) {
          selectedVoice = resolved;
        }
      }

      // Clean any old voice notes.
      const lastMsgForClean = document.querySelector('.messages .message:last-child');
      if (lastMsgForClean) {
        lastMsgForClean.querySelectorAll('.voice-generating-note').forEach(n => n.remove());
      }

      // Determine which voice to use. Prefer the live dropdown selection if the
      // Voice Settings modal is currently open (lets user test a voice without saving first).
      let currentVoiceSource = voiceSettings.voiceSource;
      let currentVoiceId = voiceSettings.voiceId;

      const voiceModalEl = document.getElementById('voice-modal');
      const voiceSelectEl = document.getElementById('voice-select');
      if (voiceModalEl && voiceModalEl.style.display === 'flex' && voiceSelectEl && voiceSelectEl.value) {
        const selVal = voiceSelectEl.value;
        if (selVal.startsWith('local:')) {
          currentVoiceSource = 'local';
          currentVoiceId = selVal.replace('local:', '');
        }
      }

      // Always resolve the local voice name (from settings or live dropdown) to the live
      // SpeechSynthesisVoice object. This must happen for persisted settings (modal closed)
      // and when voices load async.
      if (currentVoiceSource === 'local' && currentVoiceId) {
        let match = findLocalVoiceById(currentVoiceId);
        if (match) {
          selectedVoice = match;
        } else {
          // Fresh get + normalize to handle Mac/iOS name suffixes
          let voices = synth.getVoices();
          const normId = normalizeVoiceName(currentVoiceId);
          match = voices.find(v => normalizeVoiceName(v.name) === normId) ||
                  voices.find(v => v.name.toLowerCase() === currentVoiceId.toLowerCase()) ||
                  voices.find(v => normalizeVoiceName(v.name).toLowerCase().includes(normId.toLowerCase()));
          if (match) {
            selectedVoice = match;
          } else if (voices.length === 0) {
            // Voices not ready yet (common on first load or some browsers). Listen once.
            const origOnChange = synth.onvoiceschanged;
            synth.onvoiceschanged = () => {
              const fresh = synth.getVoices();
              match = fresh.find(v => normalizeVoiceName(v.name) === normId) || findLocalVoiceById(currentVoiceId);
              if (match) selectedVoice = match;
              if (origOnChange) synth.onvoiceschanged = origOnChange;
            };
          }
        }
      }

      fallbackToBrowserSpeech(text, langHint, {
        alreadyQueued: true,
        releasedLiveMic,
        interrupting
      });
    }

    // All speech is 100% local browser system voices via window.speechSynthesis.
    // No xAI / cloud / hosted TTS voices are used. speak() always resolves to fallbackToBrowserSpeech.

    function findVoiceForLangHint(langHint) {
      if (!langHint) return null;
      const voices = synth.getVoices();
      const primary = langHint.toLowerCase();
      const base = primary.split('-')[0];
      return voices.find((v) => (v.lang || '').toLowerCase() === primary)
        || voices.find((v) => (v.lang || '').toLowerCase().startsWith(base + '-'))
        || voices.find((v) => (v.lang || '').toLowerCase().startsWith(base));
    }

    function voiceMatchesLangHint(voice, langHint) {
      if (!voice || !langHint) return true;
      const vlang = (voice.lang || '').toLowerCase();
      const hint = langHint.toLowerCase();
      const base = hint.split('-')[0];
      return vlang === hint
        || vlang.startsWith(base + '-')
        || vlang.startsWith(base);
    }

    function isSpeechOutputting() {
      return synth.speaking || speechQueue.length > 0;
    }

    function clearSpeechKeepAlive() {
      if (speechKeepAliveTimer) {
        clearInterval(speechKeepAliveTimer);
        speechKeepAliveTimer = null;
      }
    }

    function resetSpeechQueue() {
      speechQueue = [];
      speechQueueIndex = 0;
      clearSpeechKeepAlive();
    }

    // Split on real sentence ends. Do not treat the dot in 1.14 / 19.9 as a boundary.
    function splitSentencesForSpeech(text) {
      if (!text) return [];
      const parts = [];
      let buf = '';
      for (let i = 0; i < text.length; i++) {
        const ch = text[i];
        buf += ch;
        if (ch !== '.' && ch !== '!' && ch !== '?') continue;
        const prev = i > 0 ? text[i - 1] : '';
        const next = i + 1 < text.length ? text[i + 1] : '';
        if (prev >= '0' && prev <= '9' && next >= '0' && next <= '9') continue;
        while (i + 1 < text.length && /["'”’)]/.test(text[i + 1])) {
          i += 1;
          buf += text[i];
        }
        const trimmed = buf.trim();
        if (trimmed) parts.push(trimmed);
        buf = '';
      }
      if (buf.trim()) parts.push(buf.trim());
      return parts.length ? parts : [text];
    }

    function wrapOversizedSpeechSentence(sentence, safetyLen) {
      safetyLen = safetyLen || 900;
      if (!sentence || sentence.length <= safetyLen) return sentence ? [sentence] : [];
      const chunks = [];
      let remain = sentence;
      while (remain.length > safetyLen) {
        const head = remain.slice(0, safetyLen);
        let cut = Math.max(head.lastIndexOf(', '), head.lastIndexOf(' '));
        if (cut < 40) cut = safetyLen;
        chunks.push(remain.slice(0, cut).trim());
        remain = remain.slice(cut).trim();
      }
      if (remain) chunks.push(remain);
      return chunks;
    }

    // First sentence only so synth.speak() can start before the rest is queued.
    function takeFirstSpeechChunk(text) {
      if (!text) return '';
      const chunks = splitTextForSpeechChunks(text);
      return chunks[0] || text;
    }

    // One utterance per sentence. Chrome/Safari cut off ~15s, so only a very
    // long sentence is word-wrapped (safety 900), never a mid-thought 220 cut.
    function splitTextForSpeechChunks(text, safetyLen) {
      if (!text) return [];
      safetyLen = safetyLen || 900;
      const chunks = [];
      const sentences = splitSentencesForSpeech(text);
      for (let s = 0; s < sentences.length; s++) {
        const wrapped = wrapOversizedSpeechSentence(sentences[s], safetyLen);
        for (let w = 0; w < wrapped.length; w++) {
          const spoken = stripSpokenFullStop(wrapped[w]);
          if (spoken) chunks.push(spoken);
        }
      }
      return chunks.length ? chunks : [stripSpokenFullStop(text) || text];
    }

    function startSpeechKeepAlive() {
      clearSpeechKeepAlive();
      // Chrome desktop can cut long utterances (~15s); pause/resume keeps them going.
      // On iOS/iPadOS WebKit, pause/resume often silences or freezes speech entirely — skip.
      if (isIOSDevice()) return;
      speechKeepAliveTimer = setInterval(() => {
        if (!isSpeechOutputting()) {
          clearSpeechKeepAlive();
          return;
        }
        try {
          synth.pause();
          synth.resume();
        } catch (e) {}
      }, 8000);
    }

    function resolveSpeechVoice(langHint = null) {
      let voiceId = resolveChatVoiceId(voiceSettings.voiceId);
      const voiceModalEl = document.getElementById('voice-modal');
      const voiceSelectEl = document.getElementById('voice-select');
      if (voiceModalEl && voiceModalEl.style.display === 'flex' && voiceSelectEl && voiceSelectEl.value && voiceSelectEl.value.startsWith('local:')) {
        voiceId = voiceSelectEl.value.replace('local:', '');
      }

      let usedVoice = voiceId ? findLocalVoiceById(voiceId) : null;
      if (!usedVoice && selectedVoice) usedVoice = selectedVoice;

      if (!usedVoice && voiceSettings.voiceSource === 'local' && voiceSettings.voiceId) {
        usedVoice = findLocalVoiceById(voiceSettings.voiceId);
      }

      // Prefer the user's saved Settings voice (same as chat). Only pick a different
      // language voice when the saved one does not match the Library language.
      if (usedVoice && (!langHint || voiceMatchesLangHint(usedVoice, langHint))) {
        selectedVoice = usedVoice;
        return { voice: usedVoice, lang: usedVoice.lang || langHint || 'en-US' };
      }

      if (langHint) {
        const langVoice = findVoiceForLangHint(langHint);
        if (langVoice) {
          return { voice: langVoice, lang: langVoice.lang || langHint };
        }
        if (usedVoice) {
          selectedVoice = usedVoice;
          return { voice: usedVoice, lang: usedVoice.lang || langHint };
        }
        return { voice: null, lang: langHint };
      }

      if (usedVoice) {
        selectedVoice = usedVoice;
        return { voice: usedVoice, lang: usedVoice.lang || 'en-US' };
      }

      return { voice: null, lang: 'en-US' };
    }

    function finishSpeechOutput() {
      resetSpeechQueue();
      currentUtterance = null;
      isAwaitingResponse = false;
      if (handsFreeEnabled && !isListening && micAllowed && document.visibilityState !== 'hidden') {
        // Slightly longer on iOS so the audio session fully flips back to capture mode.
        scheduleHandsFreeRestart(isIOSDevice() ? 1600 : 1200);
      }
    }

    function speakNextInQueue(langHint = null, allowVoiceFallback = true) {
      if (speechQueueIndex >= speechQueue.length) {
        finishSpeechOutput();
        return;
      }

      const chunkText = stripSpokenFullStop(speechQueue[speechQueueIndex++]);
      const utterance = new SpeechSynthesisUtterance(chunkText);
      currentUtterance = utterance;
      utterance.rate = voiceSettings.rate || 0.95;
      utterance.pitch = voiceSettings.pitch || 1.0;
      utterance.volume = 1.0;

      const voiceChoice = resolveSpeechVoice(langHint);
      if (allowVoiceFallback && voiceChoice.voice) {
        utterance.voice = voiceChoice.voice;
        utterance.lang = voiceChoice.lang;
      } else {
        utterance.lang = voiceChoice.lang || 'en-US';
      }

      utterance.onend = () => speakNextInQueue(langHint, allowVoiceFallback);

      utterance.onerror = (ev) => {
        // cancel/interrupt from stopSpeaking or a new speak() — do not drain or restart HF here
        if (ev.error === 'canceled' || ev.error === 'interrupted') return;
        console.error('[TTS] SpeechSynthesis error:', ev && ev.error, 'for voice:', (utterance.voice && utterance.voice.name) || 'default');
        if (allowVoiceFallback && (ev.error === 'voice-unavailable' || ev.error === 'synthesis-failed')) {
          speechQueueIndex = Math.max(0, speechQueueIndex - 1);
          speakNextInQueue(langHint, false);
          return;
        }
        speakNextInQueue(langHint, allowVoiceFallback);
      };

      try {
        // iOS can leave speechSynthesis stuck paused after backgrounding or a prior cancel.
        try { if (synth.paused) synth.resume(); } catch (e) {}
        synth.speak(utterance);
      } catch (e) {
        console.error('[TTS] speak() failed:', e);
        speakNextInQueue(langHint, allowVoiceFallback);
      }
    }

    function fallbackToBrowserSpeech(text, langHint = null, opts) {
      opts = opts || {};
      if (!opts.alreadyQueued) {
        text = cleanTextForSpeech(text, selectedVoice);
        lastSpokenText = text;
        const firstChunk = takeFirstSpeechChunk(text);
        speechQueue = firstChunk ? [firstChunk] : [];
        speechQueueIndex = 0;
      }
      const first = speechQueue[0] || '';
      const rest = text && first && text.startsWith(first)
        ? text.slice(first.length).replace(/^\s+/, '')
        : '';
      startSpeechKeepAlive();

      // speak() already canceled only if we interrupted our own speech. Do not
      // cancel() here — Chrome/WebKit delay or drop the next utterance after it.
      // The 60ms iOS gap runs only if a live mic was released in THIS speak().
      const needsIosMicFlip = !!(opts.releasedLiveMic || justReleasedLiveMic) && isIOSDevice();
      justReleasedLiveMic = false;

      const startNow = () => {
        try { synth.getVoices(); } catch (e) {}
        try { if (synth.paused) synth.resume(); } catch (e) {}
        speakNextInQueue(langHint, true);
        if (rest) {
          const more = splitTextForSpeechChunks(rest);
          for (let i = 0; i < more.length; i++) speechQueue.push(more[i]);
        }
      };
      if (needsIosMicFlip) {
        setTimeout(startNow, 60);
      } else if (opts.interrupting && typeof requestAnimationFrame === 'function') {
        requestAnimationFrame(startNow);
      } else {
        startNow();
      }
    }

    function stopSpeaking() {
      resetSpeechQueue();
      try { if (synth.speaking || synth.pending) synth.cancel(); } catch (e) {}
      currentUtterance = null;

      if (hostedAudio) {
        hostedAudio.pause();
        hostedAudio.currentTime = 0;
        hostedAudio = null;
      }

      // User manually stopped output; clear awaiting so hands-free can restart promptly if desired
      isAwaitingResponse = false;
      if (restartTimer) {
        clearTimeout(restartTimer);
        restartTimer = null;
      }
    }

    function updateStopButton() {
      const isSpeaking = isSpeechOutputting() || (hostedAudio && !hostedAudio.paused);
      stopBtn.style.display = isSpeaking ? 'inline-block' : 'none';
    }
    setInterval(updateStopButton, 400);

    // ====================== VOICE SETTINGS (unchanged, excellent) ======================
    function formatVoiceName(fullName, voiceObj) {
      // Sanitize in case we ever get a previously-labeled string (from old buggy saves or direct calls)
      fullName = fullName
        .replace(/\s*\(System\)\s*$/i, '')
        .replace(/\s*\(System Voice\)\s*$/i, '')
        .replace(/\s*\(iOS\)\s*$/i, '')
        .replace(/\s*\(Piper Neural\)\s*$/i, '')
        .replace(/\s*\(Siri\)\s*$/i, '')
        .trim();

      const lower = fullName.toLowerCase();
      const uri = ((voiceObj && voiceObj.voiceURI) || '').toLowerCase();

      // Apple/iOS system voices (Safari reports voiceURI like com.apple.voice...)
      if (uri.includes('com.apple') || uri.includes('apple.voice')) {
        if (fullName.includes('Siri Voice')) {
          const match = fullName.match(/Siri Voice \d+/);
          if (match) {
            let label = match[0];
            if (lower.includes('female') || lower.includes('us')) label += ' (US Female)';
            else if (lower.includes('male')) label += ' (US Male)';
            else label += ' (Siri)';
            return label;
          }
          return fullName;
        }
        if (fullName.includes('(Enhanced)') || /premium/i.test(fullName) || /personal voice/i.test(fullName)) {
          return fullName + ' (iOS)';
        }
        return fullName + ' (iOS)';
      }

      if (/(\(Enhanced\)|Premium|Personal Voice)/i.test(fullName)) {
        return fullName + (isIOSDevice() ? ' (iOS)' : ' (macOS)');
      }

      // Siri voices — give them nicer labels (non-URI fallback)
      if (fullName.includes("Siri Voice")) {
        const match = fullName.match(/Siri Voice \d+/);
        if (match) {
          let label = match[0];
          if (lower.includes('female') || lower.includes('us')) label += ' (US Female)';
          else if (lower.includes('male')) label += ' (US Male)';
          else label += ' (Siri)';
          return label;
        }
        return fullName;
      }

      if (fullName.includes("(Enhanced)")) {
        return fullName; // already has good info
      }

      // Generic numbered / internal system voices (very common on macOS)
      // These come from macOS Spoken Content. The browser often only sees raw numbers because
      // the OS doesn't provide friendly names or gender info for every internal voice entry.
      // We give them a clear label and rely on the per-voice 🔊 test buttons so you can hear
      // the gender/accent yourself.
      if (/^\d+/.test(fullName) || /^voice\s*\d+/i.test(fullName) || lower.includes('voice ')) {
        const cleaned = fullName.replace(/^\d+\s*/, '').replace(/^voice\s*/i, '').trim();
        const base = (cleaned || fullName).trim();
        return base + ' (macOS Internal Voice — use 🔊 to hear)';
      }

      // Default for regular system voices: append (System) so the user knows it's a local voice
      return fullName + ' (System)';
    }

    function normalizeVoiceName(name) {
      if (!name) return '';
      return name
        .replace(/\s*\(Enhanced\)/gi, '')
        .replace(/\s*\(System Voice\)/gi, '')
        .replace(/\s*\(macOS Internal Voice — use 🔊 to hear\)/gi, '')
        .replace(/\s*\(Piper Neural\)/gi, '')
        .replace(/\s*\(iOS\)/gi, '')
        .replace(/\s*\(System\)/gi, '')
        .trim();
    }

    // Robust helper to find the matching SpeechSynthesisVoice for a stored voiceId.
    // Uses exact, case-insensitive, includes, normalized names (strip Enhanced/System suffixes common on Mac/iOS),
    // and special case for UK male.
    function resolveChatVoiceId(id) {
      if (!id) return '';
      const raw = String(id).replace(/^local:/, '');
      if (window.VoicePicker && VoicePicker.isReaderOnlyVoiceId(raw)) {
        return localStorage.getItem('reader_last_system_voice')
          || localStorage.getItem('voice_name')
          || '';
      }
      return raw;
    }

    function findLocalVoiceById(id) {
      if (!id) return null;
      const voices = synth.getVoices();
      if (!voices || voices.length === 0) return null;

      const resolvedId = resolveChatVoiceId(id);
      if (!resolvedId) return null;
      const normId = normalizeVoiceName(resolvedId);

      let v = voices.find(v => v.name === resolvedId);
      if (v) return v;

      v = voices.find(v => normalizeVoiceName(v.name) === normId);
      if (v) return v;

      v = voices.find(v => v.name.toLowerCase() === resolvedId.toLowerCase());
      if (v) return v;

      v = voices.find(v => normalizeVoiceName(v.name).toLowerCase() === normId.toLowerCase());
      if (v) return v;

      v = voices.find(v => v.name.toLowerCase().includes(resolvedId.toLowerCase()));
      if (v) return v;

      v = voices.find(v => normalizeVoiceName(v.name).toLowerCase().includes(normId.toLowerCase()));
      if (v) return v;

      // Special handling for UK male preference
      if (resolvedId.toLowerCase().includes('uk') && resolvedId.toLowerCase().includes('male')) {
        v = voices.find(v => 
          v.name.toLowerCase().includes('google') && 
          v.name.toLowerCase().includes('uk') && 
          v.name.toLowerCase().includes('english') && 
          v.name.toLowerCase().includes('male')
        );
        if (v) return v;
      }
      return null;
    }

    function reloadSystemVoices() {
      // Reload voices from the OS (multiple kicks help newly installed voices like Piper appear on Mac).
      loadVoices();
      setTimeout(loadVoices, 300);
      setTimeout(loadVoices, 800);
      setTimeout(populateVoicePreviews, 200);
      setTimeout(populateVoicePreviews, 800);
    }

    // --- Custom voice labels (user can rename any voice, including numbered internal ones) ---
    function getCustomVoiceLabels() {
      try {
        return JSON.parse(localStorage.getItem('custom_voice_labels') || '{}');
      } catch (e) { return {}; }
    }
    function setCustomVoiceLabel(rawName, label) {
      const labels = getCustomVoiceLabels();
      if (label && label.trim()) {
        labels[rawName] = label.trim();
      } else {
        delete labels[rawName];
      }
      localStorage.setItem('custom_voice_labels', JSON.stringify(labels));
    }
    function getDisplayVoiceName(rawName, voiceObj) {
      const labels = getCustomVoiceLabels();
      if (labels[rawName]) return labels[rawName];
      return formatVoiceName(rawName, voiceObj);
    }

    function testSelectedVoice() {
      const sel = document.getElementById('voice-select');
      if (!sel || !sel.value) {
        alert('Please select a voice first.');
        return;
      }

      const voiceName = sel.value.replace('local:', '');
      const voice = findLocalVoiceById(voiceName);
      if (!voice) {
        alert('Could not find that voice. Try reloading the voice list.');
        return;
      }

      wakeSpeechEngine();
      try { synth.getVoices(); } catch(e){}

      const utterance = new SpeechSynthesisUtterance(
        cleanTextForSpeech("John 3:16 says: For God so loved the world, that he gave his only Son, that whoever believes in him should not perish but have eternal life.")
      );
      utterance.voice = voice;
      utterance.rate = voiceSettings.rate || 0.95;
      utterance.pitch = voiceSettings.pitch || 1.0;
      utterance.volume = 1.0;
      if (voice && voice.lang) utterance.lang = voice.lang;

      utterance.onerror = (ev) => {
        if (ev.error === 'canceled' || ev.error === 'interrupted') return;
        console.error('[TTS testSelected] error:', ev && ev.error);
      };

      if (synth.speaking) synth.cancel();

      setTimeout(() => {
        try { synth.speak(utterance); } catch (e) { console.error(e); }
      }, 60);

    }

    // Populate a separate preview list with speaker buttons so user can test ANY voice
    // without having to select it in the main dropdown first.
    function populateVoicePreviews() {
      const container = document.getElementById('voice-preview-list');
      if (!container) return;
      container.innerHTML = '';

      const voices = getBrowserVoices();
      if (!voices || voices.length === 0) {
        container.innerHTML = '<div class="voice-preview-empty">No voices loaded yet. Tap <strong>Unlock all voices</strong>, then Reload.</div>';
        updateVoiceDiagnostics();
        return;
      }

      const voicesToShow = sortVoicesForDisplay(voices);

      voicesToShow.forEach(voice => {
        const row = document.createElement('div');
        row.className = 'voice-preview-row';

        const label = document.createElement('span');
        label.className = 'voice-preview-label';
        const display = getDisplayVoiceName(voice.name, voice);
        const isRecommendedIOS = isIOSDevice() && /daniel|karen/i.test(voice.name || '');
        label.textContent = isRecommendedIOS ? `★ ${display}` : display;

        // Show raw name on hover so user can report exact internal names if needed
        row.title = `Raw: ${voice.name} | lang: ${voice.lang || '?'} | URI: ${voice.voiceURI || '?'} | local: ${voice.localService ? 'yes' : 'no'}`;

        // Clicking the name selects it in the main dropdown
        label.onclick = () => {
          const sel = document.getElementById('voice-select');
          if (sel) {
            const target = `local:${voice.name}`;
            sel.value = target;
            // trigger the existing onchange logic
            sel.dispatchEvent(new Event('change'));
          }
        };

        // Edit button to let user give a custom friendly name to any voice (great for the numbered internal ones)
        const editBtn = document.createElement('button');
        editBtn.type = 'button';
        editBtn.className = 'voice-preview-edit';
        editBtn.textContent = '✏️';
        editBtn.title = 'Rename this voice';
        editBtn.onclick = (e) => {
          e.stopImmediatePropagation();
          const currentLabel = getDisplayVoiceName(voice.name, voice);
          const input = document.createElement('input');
          input.type = 'text';
          input.value = currentLabel;
          input.style.cssText = 'flex:1; font-size:12px; padding:2px 4px;';
          input.onkeydown = (ev) => {
            if (ev.key === 'Enter') {
              setCustomVoiceLabel(voice.name, input.value);
              populateVoicePreviews(); // re-render list with new name
              loadVoices();            // refresh the main dropdown too
            }
            if (ev.key === 'Escape') {
              populateVoicePreviews();
            }
          };
          input.onblur = () => {
            setCustomVoiceLabel(voice.name, input.value);
            populateVoicePreviews();
            loadVoices();
          };
          row.replaceChild(input, label);
          input.focus();
          input.select();
        };

        const testBtn = document.createElement('button');
        testBtn.type = 'button';
        testBtn.className = 'voice-preview-test';
        testBtn.textContent = '🔊';
        testBtn.title = 'Test this voice with John 3:16';
        testBtn.onclick = (e) => {
          e.stopImmediatePropagation();
          wakeSpeechEngine();
          // Re-resolve fresh voice object right before speaking (Mac/iOS voices can go stale)
          try { synth.getVoices(); } catch(e){}
          const freshVoice = findLocalVoiceById(voice.name) || voice;
          const utterance = new SpeechSynthesisUtterance(
            cleanTextForSpeech("John 3:16 says: For God so loved the world, that he gave his only Son, that whoever believes in him should not perish but have eternal life.")
          );
          utterance.voice = freshVoice;
          utterance.rate = voiceSettings.rate || 0.95;
          utterance.pitch = voiceSettings.pitch || 1.0;
          utterance.volume = 1.0;
          if (freshVoice && freshVoice.lang) utterance.lang = freshVoice.lang;

          utterance.onerror = (ev) => { if (ev.error === 'canceled' || ev.error === 'interrupted') return; console.error('[TTS preview] error:', ev && ev.error); };

          if (synth.speaking) synth.cancel();
          setTimeout(() => {
            try { synth.speak(utterance); } catch (e) { console.error(e); }
          }, 60);
        };

        // Layout: [label] [edit] [test]
        row.appendChild(label);
        row.appendChild(editBtn);
        row.appendChild(testBtn);
        container.appendChild(row);
      });
    }

    function loadVoices() {
      const voiceSelect = document.getElementById('voice-select');
      if (!voiceSelect) return;

      const voices = getBrowserVoices();
      const voiceModal = document.getElementById('voice-modal');
      const modalOpen = voiceModal && voiceModal.style.display === 'flex';
      const preserveValue = modalOpen ? voiceSelect.value : '';

      if (!voices || voices.length === 0) {
        if (modalOpen && voiceSelect.options.length === 0) {
          voiceSelect.innerHTML = '<option value="">(No voices yet — tap Unlock all voices)</option>';
        }
        updateVoiceDiagnostics();
        return;
      }

      const savedId = resolveChatVoiceId(voiceSettings.voiceId);
      const labelFor = (voice) => {
        const display = getDisplayVoiceName(voice.name, voice);
        const isRecommendedIOS = isIOSDevice() && /daniel|karen/i.test(voice.name || '');
        return isRecommendedIOS ? `★ ${display}` : display;
      };

      const renderVoiceOptions = (catalog) => {
        if (!voiceSelect.isConnected) return;
        const cats = window.VoicePicker
          ? VoicePicker.categorizeEnglishVoices(voices, savedId, (name) => findLocalVoiceById(name))
          : { saved: null, personal: [], enhanced: [], grokStyle: [], other: sortVoicesForDisplay(voices), all: voices };

        voiceSelect.innerHTML = '';

        if (window.VoicePicker) {
          VoicePicker.appendReaderAudioGroups(voiceSelect, { disabled: true, catalog: catalog || null });
          VoicePicker.appendDeviceVoiceGroups(voiceSelect, cats, {
            getValue: (v) => `local:${v.name}`,
            getLabel: labelFor,
            selectedValue: ''
          });
        } else {
          sortVoicesForDisplay(voices).forEach((voice) => {
            const option = document.createElement('option');
            option.value = `local:${voice.name}`;
            option.textContent = labelFor(voice);
            voiceSelect.appendChild(option);
          });
        }

        const options = Array.from(voiceSelect.options).filter((o) => o.value && !o.disabled);
        const optionValues = new Set(options.map((o) => o.value));
        let pickValue = '';

        if (preserveValue && optionValues.has(preserveValue)) {
          pickValue = preserveValue;
        } else if (savedId && voiceSettings.voiceSource === 'local') {
          const exact = `local:${savedId}`;
          if (optionValues.has(exact)) {
            pickValue = exact;
          } else {
            const normSaved = normalizeVoiceName(savedId);
            const match = options.find((o) => normalizeVoiceName(o.value.replace(/^local:/, '')) === normSaved);
            if (match) pickValue = match.value;
          }
        }

        if (pickValue) {
          voiceSelect.value = pickValue;
          selectedVoice = findLocalVoiceById(pickValue.replace('local:', ''));
        }
        updateVoiceDiagnostics();
      };

      if (window.AudioEngine && window.AudioEngine.loadCatalog) {
        AudioEngine.loadCatalog().then(renderVoiceOptions).catch(() => renderVoiceOptions(null));
      } else {
        renderVoiceOptions(null);
      }
    }

    // Helper to apply the saved voice selection after voices have loaded
    function applySavedVoiceSelection() {
      const voiceSelect = document.getElementById('voice-select');
      const savedId = resolveChatVoiceId(voiceSettings.voiceId);
      if (!voiceSelect || !savedId) return;

      if (voiceSelect.options.length === 0) {
        setTimeout(applySavedVoiceSelection, 500);
        return;
      }

      const targetValue = `local:${savedId}`;
      let option = Array.from(voiceSelect.options).find(o => o.value === targetValue);
      if (!option) {
        const normSaved = normalizeVoiceName(savedId);
        option = Array.from(voiceSelect.options).find(o => normalizeVoiceName(o.value.replace(/^local:/, '')) === normSaved);
      }
      if (option) {
        voiceSelect.value = option.value;
        selectedVoice = findLocalVoiceById(savedId);
      } else {
        // Voices still loading — retry without forcing the first/top voice (Lee, UK Male, etc.)
        setTimeout(applySavedVoiceSelection, 500);
      }
    }

    function openVoiceSettings() {
      window.__voiceModalOpened = true;  // mark so defensive checks in speak() can trust the checkbox state
      const voiceModal = document.getElementById('voice-modal');
      const voiceSelect = document.getElementById('voice-select');
      const rateSlider = document.getElementById('rate-slider');
      const pitchSlider = document.getElementById('pitch-slider');
      const rateValue = document.getElementById('rate-value');
      const pitchValue = document.getElementById('pitch-value');

      voiceModal.style.display = 'flex';

      // Opening the modal is a user gesture — prime Safari/WebKit to expose the full voice list.
      wakeSpeechEngine(true);
      try { synth.getVoices(); } catch (e) {}
      scheduleVoiceListRefresh();
      setTimeout(applySavedVoiceSelection, 100);
      setTimeout(applySavedVoiceSelection, 800);

      // No legacy premium key input (11Labs fully removed).

      // Prefill custom local TTS URL (free Docker server)
      const customTtsInput = document.getElementById('custom-tts-url');
      if (customTtsInput) {
        customTtsInput.value = localStorage.getItem('custom_tts_url') || 'http://localhost:5050';
      }

      // No more XAI/cloud voice toggle (we use only excellent local system voices).
      // Live update when user clicks a different voice in the main dropdown.
      // This makes selection take effect immediately (updates voiceSettings + selectedVoice for local)
      // so speak() uses the new voice without requiring the Save button.
      if (voiceSelect) {
        voiceSelect.onchange = () => {
          const selVal = voiceSelect.value;
          if (selVal.startsWith('local:')) {
            voiceSettings.voiceSource = 'local';
            voiceSettings.voiceId = selVal.replace('local:', '');
            // Sync selectedVoice right away so fallbackToBrowserSpeech uses it
            const voices = synth.getVoices();
            selectedVoice = findLocalVoiceById(voiceSettings.voiceId);
            localStorage.setItem('voice_source', voiceSettings.voiceSource);
            localStorage.setItem('voice_id', voiceSettings.voiceId);
            // Force premium hosted off when a local voice is explicitly chosen in the main dropdown
            localStorage.setItem('use_premium_voices', 'false');
            // Sync the premium toggle UI if the modal is currently open
            const pt = document.getElementById('premium-voices-toggle');
            if (pt) pt.checked = false;
          }
          localStorage.setItem('voice_settings', JSON.stringify(voiceSettings));
        };
      }

      const autoSpeakToggle = document.getElementById('auto-speak-toggle');
      if (autoSpeakToggle) {
        autoSpeakToggle.checked = !!autoSpeakEnabled;
        autoSpeakToggle.onchange = () => {
          autoSpeakEnabled = !!autoSpeakToggle.checked;
          localStorage.setItem('auto_speak_enabled', autoSpeakEnabled ? 'true' : 'false');
        };
      }

      // Wake word settings
      const wakeEnabledToggle = document.getElementById('wake-enabled');
      if (wakeEnabledToggle) {
        wakeEnabledToggle.checked = !!wakeWordEnabled;
        wakeEnabledToggle.onchange = () => {
          wakeWordEnabled = !!wakeEnabledToggle.checked;
          localStorage.setItem('wake_word_enabled', wakeWordEnabled ? 'true' : 'false');
          if (typeof updateHandsFreeLabel === 'function') updateHandsFreeLabel();
        };
      }
      const wakeInput = document.getElementById('wake-word-input');
      if (wakeInput) {
        wakeInput.value = getWakeWordDisplay();
        wakeInput.oninput = () => {
          wakeWord = (wakeInput.value || 'John').trim() || 'John';
          syncWakeWordPresetButtons();
          if (typeof updateHandsFreeLabel === 'function') updateHandsFreeLabel();
        };
      }
      syncWakeWordPresetButtons();

      const transSelect = document.getElementById('default-trans-select');
      if (transSelect) {
        transSelect.value = getDefaultEnglishTrans();
        transSelect.onchange = () => {
          localStorage.setItem('default_english_trans', transSelect.value || 'BSB');
        };
      }

      refreshLibraryLanguageUI().catch((e) => {
        console.warn('[Settings] library language UI refresh failed:', e);
      });

      const darkToggle = document.getElementById('dark-mode-toggle');
      if (darkToggle) {
        darkToggle.checked = isDarkMode();
      }

      rateSlider.value = voiceSettings.rate;
      pitchSlider.value = voiceSettings.pitch;
      rateValue.textContent = voiceSettings.rate;
      pitchValue.textContent = voiceSettings.pitch;

      rateSlider.oninput = () => rateValue.textContent = rateSlider.value;
      pitchSlider.oninput = () => pitchValue.textContent = pitchSlider.value;
    }

    function saveVoiceSettings() {
      const voiceSelect = document.getElementById('voice-select');
      const rateSlider = document.getElementById('rate-slider');
      const pitchSlider = document.getElementById('pitch-slider');
      const selectedValue = voiceSelect.value; // e.g. "local:Daniel (Enhanced)"

      // Parse the selection into clean source + id
      if (selectedValue.startsWith('local:')) {
        voiceSettings.voiceSource = 'local';
        voiceSettings.voiceId = selectedValue.replace('local:', '');
        // Resolve to actual voice object now (so speak uses it even if modal closes)
        const match = findLocalVoiceById(voiceSettings.voiceId);
        if (match) selectedVoice = match;
        // Force premium hosted off when saving a local voice selection
        localStorage.setItem('use_premium_voices', 'false');
      } else {
        // Fallback
        voiceSettings.voiceSource = 'local';
        voiceSettings.voiceId = selectedValue;
      }

      voiceSettings.rate = parseFloat(rateSlider.value);
      voiceSettings.pitch = parseFloat(pitchSlider.value);

      // Save custom local TTS server URL (advanced/power-user path) if present
      const customTtsInput = document.getElementById('custom-tts-url');
      if (customTtsInput) {
        const url = (customTtsInput.value || '').trim();
        if (url) {
          localStorage.setItem('custom_tts_url', url);
        } else {
          localStorage.removeItem('custom_tts_url');
        }
      }

      // Persist the clean voice choice
      localStorage.setItem('voice_source', voiceSettings.voiceSource);
      localStorage.setItem('voice_id', voiceSettings.voiceId);
      localStorage.setItem('voice_rate', voiceSettings.rate);
      localStorage.setItem('voice_pitch', voiceSettings.pitch);
      localStorage.setItem('auto_speak_enabled', autoSpeakEnabled ? 'true' : 'false');
      localStorage.setItem('premium_voices_enabled', premiumVoicesEnabled ? 'true' : 'false');

      // Wake word
      const wakeEnabledToggle = document.getElementById('wake-enabled');
      if (wakeEnabledToggle) {
        wakeWordEnabled = !!wakeEnabledToggle.checked;
        localStorage.setItem('wake_word_enabled', wakeWordEnabled ? 'true' : 'false');
      }
      const wakeInput = document.getElementById('wake-word-input');
      if (wakeInput) {
        wakeWord = (wakeInput.value || 'John').trim() || 'John';
        localStorage.setItem('wake_word', wakeWord);
      }
      syncWakeWordPresetButtons();

      const transSelect = document.getElementById('default-trans-select');
      if (transSelect) {
        localStorage.setItem('default_english_trans', transSelect.value || 'BSB');
      }

      const libraryLangSel = document.getElementById('library-lang-select');
      const libraryReadingSel = document.getElementById('library-reading-trans-select');
      if (libraryLangSel && libraryReadingSel) {
        setLibraryTranslationId(libraryReadingSel.value, libraryLangSel.value);
        preloadOfflineBible();
      }

      const darkToggle = document.getElementById('dark-mode-toggle');
      if (darkToggle) {
        applyDarkMode(!!darkToggle.checked);
      }

      if (typeof updateHandsFreeLabel === 'function') {
        updateHandsFreeLabel();
      }

      // Update selectedVoice for local Mac voices
      const voices = synth.getVoices();
      if (voiceSettings.voiceSource === 'local') {
        selectedVoice = findLocalVoiceById(voiceSettings.voiceId) || null;
      } else {
        selectedVoice = null;
      }

      // Visual feedback on the button
      const saveBtn = document.getElementById('save-voice-btn');
      if (saveBtn) {
        const old = saveBtn.textContent;
        saveBtn.textContent = 'Saved!';
        setTimeout(() => {
          if (saveBtn) saveBtn.textContent = old;
        }, 900);
      }

      // Quick status hint if local TTS server is configured (easiest free option)
      const customUrlAfterSave = localStorage.getItem('custom_tts_url');
      if (customUrlAfterSave) {
        // Only log at info level if it's not the default localhost (to reduce noise in normal use)
        if (!customUrlAfterSave.includes('localhost:5050')) {
          console.log('[Voice] Custom local TTS server active:', customUrlAfterSave);
        } else {
          console.debug('[Voice] Custom local TTS server active (localhost test):', customUrlAfterSave);
        }
      }

      // Try to select the newly saved voice in the dropdown (for immediate feedback if modal re-opened quickly)
      setTimeout(() => {
        const sel = document.getElementById('voice-select');
        if (sel) {
          const target = `local:${voiceSettings.voiceId}`;
          const opt = Array.from(sel.options).find(o => o.value === target);
          if (opt) opt.selected = true;
        }
      }, 50);

      document.getElementById('voice-modal').style.display = 'none';
    }

    // ====================== SECURE API CALL (the big fix) ======================
    async function sendToGrok(userText) {
      if (commitTimeout) { clearTimeout(commitTimeout); commitTimeout = null; }
      pendingTranscript = null;
      if (restartTimer) { clearTimeout(restartTimer); restartTimer = null; }
      wakeWordActiveUntil = 0;
      longPauseUntil = 0;

      const token = getEffectiveAuthToken();
      if (!token) {
        showSignupPrompt();
        openLoginModal();
        enforceAuthRequired();
        return;
      }

      isAwaitingResponse = true;

      // Normalize typed input as well for Bible refs (e.g. "John two" -> "John 2")
      // so extraction and grounding works for typed questions too.
      if (userText) {
        userText = normalizeBibleTranscript(userText);
      }

      // Free capture now, during Thinking, so the audio session is already in
      // playback mode when the answer bubble paints. recognition.stop() alone
      // leaves getUserMedia tracks live and forced speak() to flip the session.
      releaseMicrophoneHardware();

      addMessage(userText, true);
      conversation.push({ role: "user", content: userText });
      autoSaveCurrentChat();
      updateHeaderForCurrentChat();
      renderSidebarChats(currentSearchTerm || '');

      const loadingMsg = addMessage("Thinking...", false, true);
      userInput.value = "";

      try {
        const headers = { 'Content-Type': 'application/json' };
        if (token) headers['Authorization'] = 'Bearer ' + token;

        // Strip 'sources' (which contain full Bible chapter text) from the history we send to the server.
        // Server only needs the text content to re-extract refs + for model context.
        // Full sources are kept locally for the UI "Sources" panel and persistence.
        const payloadMessages = conversation.map(m => {
          if (m.sources) {
            const { sources, ...rest } = m;
            return rest;
          }
          return m;
        });

        const response = await fetch('/api/chat', {
          method: 'POST',
          headers,
          body: JSON.stringify({ 
            messages: payloadMessages,
            defaultTranslation: getDefaultEnglishTrans()
          })
        });

        // Robust parse: protect against platform HTML error pages (e.g. Render cold-start 503/502 pages
        // or misconfigured deploys) which start with <!DOCTYPE and cause the classic "Unexpected token '<'" JSON error.
        let data;
        const ct = response.headers.get('content-type') || '';
        if (ct.includes('application/json')) {
          data = await response.json();
        } else {
          const txt = await response.text().catch(() => '');
          throw new Error(`Server returned non-JSON (status ${response.status}). ${txt.slice(0, 150)}`);
        }
        removeLoadingMessage();

        if (!response.ok) {
          const errMsg = data?.error || `Error: ${response.status}`;
          addMessage(errMsg, false);
          conversation.pop();
          autoSaveCurrentChat();
          updateHeaderForCurrentChat();
          renderSidebarChats(currentSearchTerm || '');
          if ((response.status === 401 || response.status === 403)) {
            if (!token) {
              showSignupPrompt();
              openLoginModal();
              enforceAuthRequired();
            } else {
            const modal = document.getElementById('subscribe-modal');
            if (modal) {
              modal.style.display = 'flex';
              // Populate like the button click does (for stale token case)
              const accountInfo = document.getElementById('account-info');
              const loginSection = document.getElementById('login-section');
              const emailEl = document.getElementById('account-email');
              const statusEl = document.getElementById('account-status');
              const modalTitle = modal.querySelector('h3');
              if (modalTitle) modalTitle.textContent = 'Account';
              if (accountInfo) accountInfo.style.display = '';
              if (loginSection) loginSection.style.display = 'none';
              const setPwSection = document.getElementById('set-password-section');
              if (setPwSection) setPwSection.style.display = 'none';

              const lb = document.getElementById('logout-btn');
              if (lb) { lb.textContent = 'Log out'; lb.style.background = '#555'; lb.style.color = 'white'; }

              fetch('/api/me', { headers: { 'Authorization': 'Bearer ' + token } })
                .then(r => r.json())
                .then(data => {
                  if (emailEl) emailEl.textContent = data.email || 'Logged in';
                  if (statusEl) {
                    let txt = data.status || 'active';
                    if (data.trial_end) txt += ' (trial ends ' + new Date(data.trial_end).toLocaleDateString() + ')';
                    if (!data.access_granted) txt = 'Access revoked';
                    statusEl.textContent = txt;
                  }
                  const setPwSection = document.getElementById('set-password-section');
                  if (setPwSection) {
                    setPwSection.style.display = data.has_password ? 'none' : '';
                  }
                  const setPwBtn = document.getElementById('set-password-btn');
                  if (setPwBtn) {
                    setPwBtn.textContent = (data.has_password ? 'Change Password' : 'Set Password');
                  }
                })
                .catch(() => {
                  if (emailEl) emailEl.textContent = localStorage.getItem('user_email') || 'Logged in';
                  if (statusEl) statusEl.textContent = 'Active (token may be expired)';
                  const setPwSection = document.getElementById('set-password-section');
                  if (setPwSection) setPwSection.style.display = 'none';
                });
            }
            }
          }
          return;
        }

        const reply = data.reply || "No response received.";
        const sources = Array.isArray(data.sources) ? data.sources : [];

        const msgEl = addMessage(reply, false);

        // TTS must start the same moment the bubble is on screen — do not wait for
        // Sources UI, localStorage save, or sidebar render. Auto-speak is the toggle;
        // hands-free is only required for the wake-word listen loop, not for speaking.
        if (autoSpeakEnabled) {
          if (voiceSettings.voiceSource !== 'local') {
            voiceSettings.voiceSource = 'local';
            localStorage.setItem('voice_source', 'local');
          }
          speak(reply);
        } else if (handsFreeEnabled) {
          isAwaitingResponse = false;
          scheduleHandsFreeRestart(800);
        } else {
          isAwaitingResponse = false;
        }

        attachAssistantMessageActions(msgEl, reply, userText);

        if (sources.length > 0) {
          attachSourcesUI(msgEl, sources, reply);
        }

        conversation.push({ role: "assistant", content: reply, sources: sources.length ? sources : undefined });

        autoSaveCurrentChat();
      updateHeaderForCurrentChat();
      renderSidebarChats(currentSearchTerm || '');

        enforceAuthRequired();
      } catch (err) {
        removeLoadingMessage();
        isAwaitingResponse = false;
        const isRate = /429|rate limit|too many requests/i.test(err.message || '');
        const niceMsg = isRate 
          ? "xAI is rate limiting right now (tier RPM/TPM cap). Using local fallback if speaking. Try again soon — limits grow with usage."
          : "Connection error: " + err.message;
        addMessage(niceMsg, false);
        conversation.pop();
        if (handsFreeEnabled) {
          scheduleHandsFreeRestart(800);
        }
      }
    }

    // Pause commands must be the whole utterance ("John pause"), not a substring.
    // The old /sec/ regex matched "second", "section", "persecute" and then waited 60s
    // without committing — transcript visible, /api/chat never called.
    function isExplicitPauseCommand(text) {
      const t = (text || '').toLowerCase().replace(/[^\w\s]/g, ' ').replace(/\s+/g, ' ').trim();
      return /^(please )?(pause|hold|hold on|wait|wait a (sec|second)|one sec|one second|thinking|breath|breathe)( please)?$/.test(t);
    }

    // A breath or mid-sentence think is ~1s. 450ms/850ms was sending half-questions.
    // Explicit "John pause" still uses longPauseUntil (60s), not this window.
    function voiceCommitDelayMs() {
      if (longPauseUntil > Date.now()) return 60000;
      return 2300;
    }
    function handsFreeCommitDelayMs() {
      return voiceCommitDelayMs();
    }

    function rememberVoiceTranscript(transcript) {
      const t = (transcript || '').trim();
      if (!t || t.length < 2) return;
      if (!pendingTranscript) {
        pendingTranscript = t;
        return;
      }
      const prev = pendingTranscript;
      if (t === prev) return;
      if (t.length >= prev.length && (t.startsWith(prev) || t.includes(prev))) {
        pendingTranscript = t;
        return;
      }
      if (prev.includes(t) && t.length < prev.length) return;
      pendingTranscript = (prev + ' ' + t).replace(/\s+/g, ' ').trim();
    }

    function scheduleVoiceCommit() {
      if (commitTimeout) clearTimeout(commitTimeout);
      const delay = voiceCommitDelayMs();
      commitTimeout = setTimeout(() => {
        commitTimeout = null;
        const ft = (pendingTranscript || '').trim();
        if (!ft || ft.length < 2 || isAwaitingResponse) return;
        pendingTranscript = null;
        longPauseUntil = 0;
        if (tapToTalkTurn || !handsFreeEnabled) {
          consumeAndSendVoice(ft);
        } else {
          commitHandsFreeTranscript(ft, lastTranscriptConfidence || 0);
        }
      }, delay);
    }

    function showLiveListeningPlaceholder() {
      const liveContainer = document.getElementById('live-transcript-container');
      if (liveContainer) liveContainer.style.display = 'block';
      updateLiveTranscriptHint('');
      const liveEl = document.getElementById('live-transcript');
      if (liveEl) liveEl.textContent = 'Listening...';
    }

    // Send recognized speech the same way as typing Send. Used for tap-to-talk and
    // for flushing a leftover transcript when recognition ends without isFinal.
    function consumeAndSendVoice(text) {
      const t = (text || '').trim();
      if (!t || t.length < 2) return false;
      if (isAwaitingResponse) return false;
      if (Date.now() - lastVoiceSendAt < 400) return false;
      lastVoiceSendAt = Date.now();

      tapToTalkTurn = false;
      pendingTranscript = null;
      if (commitTimeout) { clearTimeout(commitTimeout); commitTimeout = null; }

      stopListeningUI();
      if (recognition) {
        try { recognition.stop(); } catch (e) {}
      }

      sendToGrok(normalizeBibleTranscript(t));
      return true;
    }

    // ====================== SPEECH RECOGNITION (preserved & excellent) ======================
    function setupSpeechRecognition() {
      const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
      if (!SpeechRecognition) {
        micBtn.style.opacity = "0.4";
        micBtn.title = "Voice input not supported in this browser";
        return;
      }

      recognition = new SpeechRecognition();
      recognition.continuous = true;
      recognition.interimResults = true;
      recognition.lang = "en-US";

      recognition.onresult = (event) => {
        // Build the full utterance from ALL result segments (not just the last one).
        // Using only results[length-1] made the live captions show a fragment instead of what you said.
        const transcript = buildTranscriptFromResults(event);
        const lastResult = event.results[event.results.length - 1];
        const confidence = (lastResult && lastResult[0].confidence) || 0;
        const isFinal = lastResult && lastResult.isFinal;

        currentTranscript = transcript;

        // Live captions: show exactly what the browser heard (tap-to-talk and hands-free).
        updateLiveTranscript(transcript);
        if (tapToTalkTurn && userInput && transcript) {
          userInput.value = transcript;
        }

        // Tap-to-talk: accumulate. A natural pause / isFinal must NOT send.
        // Auto-send only after ~2.3s of real silence. Second mic tap or Send
        // still commits immediately (see mic click / consumeAndSendVoice).
        if (tapToTalkTurn) {
          rememberVoiceTranscript(transcript);
          lastTranscriptConfidence = confidence;
          if (userInput && pendingTranscript) userInput.value = pendingTranscript;
          if (pendingTranscript && pendingTranscript.length > 1) scheduleVoiceCommit();
          return;
        }

        if (handsFreeEnabled) {
          const isCurrentlySpeaking = isSpeechOutputting() || (hostedAudio && !hostedAudio.paused);
          const hasWake = containsWakeWord(transcript);
          const cmd = hasWake ? stripWakeWordPrefix(transcript) : '';

          if (hasWake) {
            // Strong interrupt: if the wake word is heard while the AI is speaking,
            // immediately stop the voice so the user can talk.
            if (isCurrentlySpeaking) {
              stopSpeaking();
            }

            // If we are in a long-pause mode (user said wake+pause etc.) and this is a new wake,
            // it means the user is ready to submit the previous long thought (they may have taken a breath or thought).
            if (longPauseUntil > Date.now() && pendingTranscript) {
              const previousThought = pendingTranscript;
              const prevConf = lastTranscriptConfidence || 0;
              pendingTranscript = null;
              longPauseUntil = 0;
              // Commit the accumulated thought from the long pause
              setTimeout(() => {
                commitHandsFreeTranscript(previousThought, prevConf);
              }, 0);
              // If they also gave a new command after this "John", queue it as follow-up
              if (cmd && cmd.length > 1) {
                pendingTranscript = cmd;
                lastTranscriptConfidence = confidence;
                wakeWordActiveUntil = Date.now() + 9000;
                scheduleVoiceCommit();
              } else {
                wakeWordActiveUntil = Date.now() + 9000;
              }
              return;
            }

            if (isCurrentlySpeaking) {
              // Barge-in already handled above with stopSpeaking().
              // If they gave a full command after the wake word, queue it.
              if (cmd && cmd.length > 1) {
                pendingTranscript = cmd;
                lastTranscriptConfidence = confidence;
                scheduleVoiceCommit();
                return;
              } else {
                // Just the name — open a window for the user to speak their command.
                wakeWordActiveUntil = Date.now() + 9000;
                return;
              }
            } else {
              // Normal activation (not speaking): do NOT send on interim.
              // Prime/accumulate the pending with the cleaned command (across segments if needed)
              // and reset the silence timer. This prevents "responding too fast" on partials
              // and makes long commands after "John" work reliably.

              // Check if user wants a much longer pause (breathing, thinking, etc.).
              // Must be the whole command — substring "sec" used to match "second".
              if (isExplicitPauseCommand(cmd) || isExplicitPauseCommand(stripWakeWordPrefix(transcript))) {
                longPauseUntil = Date.now() + 180000; // allow up to 3 minutes of silence for this turn
                // Keep whatever was said before the pause command in pending
                if (commitTimeout) clearTimeout(commitTimeout);
                // Safety net: auto-commit after 60s of silence even in long-pause mode
                commitTimeout = setTimeout(() => {
                  if (pendingTranscript) {
                    const ft = pendingTranscript;
                    pendingTranscript = null;
                    commitTimeout = null;
                    longPauseUntil = 0;
                    commitHandsFreeTranscript(ft, lastTranscriptConfidence || 0);
                  }
                }, 60000);
                wakeWordActiveUntil = longPauseUntil;
                return;
              }

              const thisCmd = cmd || stripWakeWordPrefix(transcript) || transcript;
              rememberVoiceTranscript(thisCmd);
              lastTranscriptConfidence = confidence;
              wakeWordActiveUntil = Date.now() + 9000; // keep window open for continuation segments without repeating the name
              if (longPauseUntil > Date.now()) {
                longPauseUntil = Date.now() + 180000;
              }
              scheduleVoiceCommit();
              return;
            }
          }

          // If AI is speaking, ignore non-wake input (prevents noise from affecting output).
          if (isCurrentlySpeaking) {
            return;
          }

          // Handle the case where user said just the name earlier (wakeWordActiveUntil window)
          // and this utterance has no "John" in it but is within the window.
          const recentlyWoke = Date.now() < wakeWordActiveUntil;
          if (recentlyWoke) {
            // Continuation after hearing the name earlier — use the latest full transcript,
            // not a fragment append (buildTranscriptFromResults already has the full utterance).
            const continuation = stripWakeWordPrefix(transcript) || transcript.trim();
            rememberVoiceTranscript(continuation);
            lastTranscriptConfidence = confidence;
            wakeWordActiveUntil = Date.now() + 9000; // extend window while user is speaking
            if (longPauseUntil > Date.now()) {
              longPauseUntil = Date.now() + 180000;
            }
            scheduleVoiceCommit();
            return;
          }

          // No wake word and not in active window: for hands-free we ignore to avoid noise commits.
          // (Non-handsfree branch below handles explicit mic use.)
          return;
        }

        // Non-handsfree fallback (tapToTalkTurn should already have handled this).
        rememberVoiceTranscript(transcript);
        if (userInput && pendingTranscript) userInput.value = pendingTranscript;
        if (pendingTranscript && pendingTranscript.length > 1) scheduleVoiceCommit();
      };

      recognition.onerror = (event) => {
        const errType = event.error;
        // Suppress very common benign errors in hands-free to avoid console spam.
        // 'aborted' is common when we stop/restart the recognizer.
        // 'no-speech' is handled with restart.
        if (errType !== 'no-speech' && errType !== 'aborted') {
          const logKey = 'sr-log-' + errType;
          window._srLogCount = window._srLogCount || {};
          window._srLogCount[logKey] = (window._srLogCount[logKey] || 0) + 1;
          if (window._srLogCount[logKey] <= 5) {
            console.warn("Speech recognition error:", errType, event.message || '');
          }
        }

        stopListeningUI();

        if (errType === "no-speech" || errType === "aborted") {
          if (micAllowed && handsFreeEnabled && !startingRecognition && !isAwaitingResponse && document.visibilityState !== 'hidden') {
            const isOutputting = isSpeechOutputting() || (hostedAudio && !hostedAudio.paused);
            if (!isOutputting) {
              // Use centralized scheduler (prevents timer pile-up). Slightly patient delay.
              scheduleHandsFreeRestart(1400);
            }
          }
          return;
        }

        // Handle real problems
        if (errType === 'network' || errType === 'audio-capture' || errType === 'not-allowed' || errType === 'service-not-allowed') {
          const isNetwork = event.error === 'network';
          if (handsFreeEnabled) {
            // Tell the user once (avoid spam)
            const key = 'sr-' + event.error;
            if (!window._srErrorShown || !window._srErrorShown[key]) {
              window._srErrorShown = window._srErrorShown || {};
              window._srErrorShown[key] = true;
              let userMsg = "Speech recognition problem (" + event.error + "). ";
              if (isNetwork) {
                userMsg += "This is usually Chrome's cloud speech service having a temporary issue (internet/VPN/firewall). Hands-free is paused. You can still type messages or use the mic button manually. Toggle Hands-free off and back on to retry.";
              } else {
                userMsg += "Check your microphone permissions or try a different browser. Hands-free paused for now.";
              }
              addMessage(userMsg, false);
            }
            // Long cooldown — don't auto-restart the loop aggressively
            // User can manually click the mic or toggle hands-free to resume.
          }

          // For network errors, recreate the recognizer after a short delay to get a clean state
          if (isNetwork) {
            setTimeout(() => {
              if (micAllowed && handsFreeEnabled && recognition && document.visibilityState !== 'hidden') {
                try {
                  resetSpeechRecognition();
                } catch (e) {}
              }
            }, 2500);
          }
          return;
        }

        // For other unexpected errors, let the onend handler decide restart (with the safeguards above).
      };

      recognition.onend = () => {
        const leftover = (pendingTranscript || currentTranscript || '').trim();
        if (leftover.length > 1) rememberVoiceTranscript(leftover);
        // Browser silence ends the utterance. That is a breath, not "send".
        // Keep the pending question, wait ~2.3s, and keep listening so more
        // words append. Second mic tap / Send still commits immediately.
        const keepOpenQuestion = leftover.length > 1 && !isAwaitingResponse
          && (tapToTalkTurn || !handsFreeEnabled);
        stopListeningUI();
        if (isAwaitingResponse) return;
        if (keepOpenQuestion) {
          scheduleVoiceCommit();
          if (micAllowed && document.visibilityState !== 'hidden' && !startingRecognition) {
            startListening();
          }
          return;
        }
        if (!micAllowed || document.visibilityState === 'hidden') return;
        const isOutputting = isSpeechOutputting() || (hostedAudio && !hostedAudio.paused);
        if (handsFreeEnabled && !isOutputting && !isListening && !isAwaitingResponse && !startingRecognition) {
          scheduleHandsFreeRestart(800);
        }
      };
    }

    function startListening() {
      if (!micAllowed) return;
      if (!recognition) {
        alert("Voice input is not supported in this browser. Use Chrome, Edge, or Safari.");
        return;
      }
      if (isListening || startingRecognition) return;

      if (restartTimer) {
        clearTimeout(restartTimer);
        restartTimer = null;
      }

      currentTranscript = '';

      // Don't cut off AI speech in hands-free auto-listen — recognition stays open during TTS for barge-in only.
      // An explicit mic tap (tapToTalkTurn) cancels TTS and records this question.
      if (isSpeechOutputting()) {
        if (handsFreeEnabled && !tapToTalkTurn) {
          scheduleHandsFreeRestart(500);
          return;
        }
        if (synth.speaking) synth.cancel();
      }

      if (hostedAudio) {
        try { hostedAudio.pause(); hostedAudio.currentTime = 0; } catch (e) {}
        hostedAudio = null;
      }

      // Mark starting before stop() so a sync onend cannot re-enter startListening.
      startingRecognition = true;

      // Always attempt a clean stop first. The Web Speech API state machine is picky;
      // calling start() too soon after end/error or without stopping often throws InvalidStateError.
      if (recognition) {
        try { recognition.stop(); } catch (e) {}
      }

      // Small grace delay after stop() dramatically reduces "already started" races.
      // We do NOT schedule another start on InvalidStateError here; we let the 'onend' event
      // fire (which it will) and let the onend handler decide whether to restart. This prevents
      // thundering herds of overlapping start attempts.
      setTimeout(() => {
        if (!micAllowed || document.visibilityState === 'hidden') {
          startingRecognition = false;
          return;
        }
        if (isListening) {
          startingRecognition = false;
          return;
        }
        // For auto hands-free restarts, don't start if we're still in the middle of an AI response.
        // An explicit mic tap is allowed so the user can ask the next question immediately.
        if (handsFreeEnabled && isAwaitingResponse && !tapToTalkTurn) {
          startingRecognition = false;
          return;
        }

        try {
          // Stay continuous so a breath does not end the utterance and send
          // a half-question. We commit after ~2.3s of silence or a second mic tap.
          recognition.continuous = true;
          recognition.interimResults = true;
          recognition.start();
          isListening = true;
          micBtn.classList.add("listening");
          micBtn.textContent = "●";
          startingRecognition = false;

          // Start capturing raw audio for this utterance (hands-free only).
          // We keep using the fast browser recognizer for wake word, barge-in, and interim text.
          // We also send accumulating audio chunks live to /api/stt (xAI with heavy Bible keyterm boosting)
          // for streaming improved transcription shown to the user. This uses the best available
          // model for accuracy on scripture references (far better than raw browser STT on names/numbers).
          // The user sees the accurate text updating live and can correct by speaking clearly.
          if (handsFreeEnabled && serverHasSTT) {
            startAudioCaptureForCurrentUtterance().catch(() => {});
            showLiveListeningPlaceholder();
          } else if (handsFreeEnabled || tapToTalkTurn) {
            showLiveListeningPlaceholder();
          }
        } catch (e) {
          startingRecognition = false;
          if (e.name === 'InvalidStateError') {
            console.warn("Recognition already started, will retry on end");
            // Do not schedule here. onend (or a future manual trigger) will handle restart.
          } else {
            console.error(e);
          }
          stopListeningUI();
        }
      }, 120);  // slightly longer grace to give the recognizer time to settle after stop()
    }

    function stopListeningUI() {
      isListening = false;
      startingRecognition = false;
      currentTranscript = '';
      micBtn.classList.remove("listening");
      micBtn.textContent = "🎙️";

      // Hide and clear the live transcript
      const liveContainer = document.getElementById('live-transcript-container');
      if (liveContainer) liveContainer.style.display = 'none';
      const liveEl = document.getElementById('live-transcript');
      if (liveEl) liveEl.textContent = '';

      // Finalize any in-progress audio capture for the just-ended utterance.
      // The blob (if any) will be available in lastUtteranceAudioBlob for the commit path.
      stopAndFinalizeAudioCapture();
    }

    // Start (or restart) a MediaRecorder on the mic for the current user turn.
    // We request the stream once and reuse it. Only the audio from the active listening
    // window is kept (we clear chunks on start of a new command turn).
    async function startAudioCaptureForCurrentUtterance() {
      try {
        if (!micAllowed || document.visibilityState === 'hidden') return;
        if (!mediaStream) {
          mediaStream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
          // Page may have been backgrounded while the permission prompt was open.
          if (!micAllowed || document.visibilityState === 'hidden') {
            try {
              mediaStream.getTracks().forEach((t) => { try { t.stop(); } catch (e) {} });
            } catch (e) {}
            mediaStream = null;
            return;
          }
        }
        // Stop any previous recorder cleanly
        if (mediaRecorder && mediaRecorder.state !== 'inactive') {
          try { mediaRecorder.stop(); } catch (e) {}
        }
        audioChunks = [];
        lastUtteranceAudioBlob = null;

        // Prefer webm/opus (widely supported and good quality for STT). Fall back to default.
        const options = { mimeType: 'audio/webm;codecs=opus' };
        mediaRecorder = new MediaRecorder(mediaStream, MediaRecorder.isTypeSupported(options.mimeType) ? options : undefined);

        mediaRecorder.ondataavailable = (e) => {
          if (e.data && e.data.size > 0) audioChunks.push(e.data);
          // Trigger live server STT for improved (boosted) transcription display.
          // This gives the user accurate live text using the best domain-tuned model (xAI STT + keyterms),
          // instead of raw browser STT which is often inaccurate on Bible names/numbers.
          triggerLiveImprovedStt();
        };
        mediaRecorder.onstop = () => {
          if (audioChunks.length > 0) {
            lastUtteranceAudioBlob = new Blob(audioChunks, { type: mediaRecorder.mimeType || 'audio/webm' });
            // Keep chunks for potential re-use until next turn; they are cleared on next start.
          }
        };

        // Start with timeslice so ondataavailable fires periodically (for live STT updates during speaking).
        // This enables streaming-like improved transcription using the server xAI STT (with Bible boosting).
        mediaRecorder.start(900); // ~every 900ms chunk for responsive live updates without too much overhead
        // console.log('[audio] recording started for utterance');
      } catch (err) {
        // Permission denied or no mic support — silently fall back to browser transcript only.
        // This is fine; the browser STT still works.
        console.warn('[audio] could not start raw capture for STT (will use browser transcript only):', err && err.name);
        mediaStream = null;
        mediaRecorder = null;
        audioChunks = [];
        lastUtteranceAudioBlob = null;
      }
    }

    function stopAndFinalizeAudioCapture() {
      if (mediaRecorder && mediaRecorder.state === 'recording') {
        try { mediaRecorder.stop(); } catch (e) {}
      }
      // lastUtteranceAudioBlob will be set in the onstop handler above (async).

      // Clear any pending live STT update
      if (liveSttTimer) {
        clearTimeout(liveSttTimer);
        liveSttTimer = null;
      }
    }

    // Fully release OS microphone hardware (MediaStream tracks + SpeechRecognition + timers).
    // stopListeningUI / recognition.stop alone leave getUserMedia tracks live, so the system
    // mic indicator stays on after closing the tab, backgrounding the PWA, or turning HF off.
    function releaseMicrophoneHardware() {
      if (restartTimer) {
        clearTimeout(restartTimer);
        restartTimer = null;
      }
      if (commitTimeout) {
        clearTimeout(commitTimeout);
        commitTimeout = null;
      }
      if (liveSttTimer) {
        clearTimeout(liveSttTimer);
        liveSttTimer = null;
      }

      if (mediaRecorder) {
        try {
          if (mediaRecorder.state !== 'inactive') mediaRecorder.stop();
        } catch (e) {}
        try {
          mediaRecorder.ondataavailable = null;
          mediaRecorder.onstop = null;
        } catch (e) {}
        mediaRecorder = null;
      }

      if (mediaStream) {
        try {
          mediaStream.getTracks().forEach((track) => {
            try { track.stop(); } catch (e) {}
          });
        } catch (e) {}
        mediaStream = null;
      }
      audioChunks = [];
      lastUtteranceAudioBlob = null;

      if (recognition) {
        try {
          recognition.abort();
        } catch (e) {
          try { recognition.stop(); } catch (e2) {}
        }
      }

      isListening = false;
      startingRecognition = false;
      currentTranscript = '';
      if (micBtn) {
        micBtn.classList.remove('listening');
        micBtn.textContent = '🎙️';
      }
      const liveContainer = document.getElementById('live-transcript-container');
      if (liveContainer) liveContainer.style.display = 'none';
      const liveEl = document.getElementById('live-transcript');
      if (liveEl) liveEl.textContent = '';
    }

    function suspendMicrophoneForLifecycle() {
      micAllowed = false;
      releaseMicrophoneHardware();
      try {
        if (typeof synth !== 'undefined' && synth) synth.cancel();
      } catch (e) {}
      if (hostedAudio) {
        try { hostedAudio.pause(); hostedAudio.currentTime = 0; } catch (e) {}
        hostedAudio = null;
      }
    }

    function resumeMicrophoneAfterLifecycle() {
      micAllowed = true;
      if (handsFreeEnabled && !isListening && !isAwaitingResponse && !startingRecognition) {
        scheduleHandsFreeRestart(500);
      }
    }

    // Debounced live call to server STT for accurate (keyterm-boosted) transcription while the user is still speaking.
    // This provides "streaming" improved text to the user using the best available model for this domain
    // (xAI STT with extensive Bible book/chapter/verse keyterm boosting). Browser STT is used only for fast wake/barge-in.
    function triggerLiveImprovedStt() {
      if (window.__sttLiveDisabled || !serverHasSTT) {
        const lc = document.getElementById('live-transcript-container');
        if (lc) lc.style.display = 'none';
        return;
      }
      if (liveSttTimer) clearTimeout(liveSttTimer);
      liveSttTimer = setTimeout(async () => {
        liveSttTimer = null;
        if (audioChunks.length < 2 || !handsFreeEnabled || isAwaitingResponse) return;
        try {
          // Use current accumulated audio for a partial improved transcript
          const tempBlob = new Blob(audioChunks, { type: mediaRecorder.mimeType || 'audio/webm' });
          // Short timeout so live updates don't delay the UI
          const improved = await improveTranscriptWithSTT(currentTranscript || '', tempBlob, 2800);
          if (improved && improved.trim().length > 2) {
            currentTranscript = improved;
            updateLiveTranscript(improved);
          }
        } catch (err) {
          // Silent fail for live updates — we still have browser interim as fallback
        }
      }, 1100); // debounce ~1.1s after latest chunk
    }

    function waitingForWakeWord(heardText) {
      return !!(handsFreeEnabled && wakeWordEnabled && !tapToTalkTurn
        && Date.now() >= wakeWordActiveUntil
        && !containsWakeWord(heardText));
    }

    function updateLiveTranscriptHint(heardText) {
      const hint = document.getElementById('live-transcript-hint');
      if (!hint) return;
      if (waitingForWakeWord(heardText)) {
        hint.textContent = 'Say “' + getWakeWordDisplay() + '”, then your question';
      } else {
        hint.textContent = 'Listening — you said:';
      }
    }

    function updateLiveTranscript(text) {
      const container = document.getElementById('live-transcript-container');
      const el = document.getElementById('live-transcript');
      if (!container || !el) return;
      updateLiveTranscriptHint(text);
      if (text && text.trim()) {
        el.textContent = text;
        container.style.display = 'block';
      } else {
        container.style.display = 'none';
      }
    }

    // Piper / eSpeak-style voices read leftover "." as "dot". Default Apple/Chrome
    // voices keep commas in the cleaner; trailing periods are stripped per chunk
    // so British voices (Daniel, UK English) cannot say "full stop".
    function voiceSpeaksPunctuationNames(voice) {
      if (!voice) return false;
      const name = `${voice.name || ''} ${voice.voiceURI || ''}`.toLowerCase();
      if (/google|samantha|daniel|karen|moira|alex|siri|microsoft|premium|enhanced|apple/.test(name)) {
        return false;
      }
      return /piper|espeak|festival|mbrola|coqui|mimic|rhasspy|sherpa|opencat|internal voice/.test(name);
    }

    // Voices must not read "." as "dot" / "period" / "full stop".
    // Keep commas and ? !; the gap between sentence utterances is the pause.
    function stripSpokenFullStop(text) {
      if (!text) return '';
      return String(text)
        .replace(/([A-Za-z”’'")\]])[.]+(?=\s*$)/g, '$1')
        .replace(/\s+/g, ' ')
        .trim();
    }

    // Markdown/Greek off. Verse colons become spaces. Default voices KEEP
    // sentence periods, question marks, and commas for natural tone.
    function cleanTextForSpeech(text, voice) {
      if (!text) return '';

      const decimals = [];
      let out = String(text).replace(/\b\d+\.\d+\b/g, (m) => {
        decimals.push(m);
        return `\u0000D${decimals.length - 1}\u0000`;
      });

      out = out
        .replace(/\*\*(.+?)\*\*/g, '$1')
        .replace(/\*(.+?)\*/g, '$1')
        .replace(/`(.+?)`/g, '$1')
        .replace(/^#{1,6}\s*/gm, '')
        .replace(/^\s*[-*+]\s+/gm, '');

      out = out.replace(/\b(\d+)\s*:\s*(\d+)(?:\s*[–—-]\s*(\d+))?\b/g, (_, ch, v1, v2) => (
        v2 ? `${ch} ${v1} to ${v2}` : `${ch} ${v1}`
      ));

      out = out
        .replace(/[*\-#`~_]/g, '')
        .replace(/[\u0370-\u03FF\u1F00-\u1FFF\u0590-\u05FF]+/g, '')
        .replace(/\(\s*\)/g, '')
        .replace(/[“”«»„"]/g, '')
        .replace(/(^|\s)['‘’]/g, '$1')
        .replace(/['‘’](?![A-Za-z])/g, '')
        .replace(/[()[\]{}]/g, ' ')
        .replace(/[–—]/g, ', ')
        .replace(/:/g, ', ')
        .replace(/…+/g, '. ')
        .replace(/\.{3,}/g, '. ')
        .replace(/\n{2,}/g, '. ')
        .replace(/\n/g, ' ');

      if (voiceSpeaksPunctuationNames(voice)) {
        out = out
          .replace(/[;!?•]+/g, ' ')
          .replace(/,/g, ' ')
          .replace(/\./g, ' ');
      }

      out = out.replace(/\s+/g, ' ').trim();
      return out.replace(/\u0000D(\d+)\u0000/g, (_, i) => decimals[Number(i)] || '');
    }

    // Small helper so the async onstop has time to populate the blob before we try to send it.
    function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

    // Helper to completely recreate the SpeechRecognition instance after bad errors (network etc).
    // The Web Speech API can get into a bad state after certain errors; fresh instance helps.
    function resetSpeechRecognition() {
      startingRecognition = false;
      if (recognition) {
        try {
          recognition.onresult = null;
          recognition.onerror = null;
          recognition.onend = null;
          try { recognition.stop(); } catch (e) {}
        } catch (e) {}
        recognition = null;
      }
      // Re-attach everything
      setupSpeechRecognition();
    }

    // Centralized restart scheduler for hands-free to avoid overlapping timers that cause
    // "Recognition already started" + laggy / noisy behavior.
    function scheduleHandsFreeRestart(delayMs = 800) {
      if (!micAllowed || !handsFreeEnabled) return;
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
      if (restartTimer) {
        clearTimeout(restartTimer);
      }
      restartTimer = setTimeout(() => {
        restartTimer = null;
        tapToTalkTurn = false; // auto-restart stays wake-word gated
        if (!micAllowed || document.visibilityState === 'hidden') return;
        if (handsFreeEnabled && !isListening && !isAwaitingResponse && !startingRecognition) {
          if (isSpeechOutputting()) {
            scheduleHandsFreeRestart(500);
            return;
          }
          startListening();
        }
      }, delayMs);
    }

    // === Wake word support (customizable, default "John") ===
    // Only process commands when the user addresses it by name (unless turned off).
    // This greatly reduces false triggers from background noise.
    // Also allows saying the name while the AI is speaking to interrupt ("barge in").
    function getCurrentWakePhrases() {
      if (!wakeWordEnabled) return [];
      const base = (wakeWord || 'John').trim().toLowerCase();
      if (!base) return [];
      return [
        base,
        base.replace(/\s+/g, ''),
        'hey ' + base,
        'hey ' + base.replace(/\s+/g, '')
      ];
    }

    function containsWakeWord(text) {
      if (!text) return false;
      if (!wakeWordEnabled) return true; // wake word turned off: treat all speech as addressed
      const t = text.toLowerCase();
      return getCurrentWakePhrases().some(phrase => t.includes(phrase));
    }

    // Strip the wake word prefix only — used for live captions / pending accumulation (no rewriting).
    function stripWakeWordPrefix(fullText) {
      if (!fullText) return '';
      const lower = fullText.toLowerCase();
      let startIdx = -1;
      let wakeLen = 0;

      const phrases = getCurrentWakePhrases();
      for (const phrase of phrases) {
        const i = lower.indexOf(phrase);
        if (i !== -1) {
          startIdx = i;
          wakeLen = phrase.length;
          break;
        }
      }
      if (startIdx === -1) return '';

      return fullText.substring(startIdx + wakeLen).replace(/^[\s,.;:!?]+/, '').trim();
    }

    function buildTranscriptFromResults(event) {
      if (!event || !event.results) return '';
      let transcript = '';
      for (let i = 0; i < event.results.length; i++) {
        transcript += event.results[i][0].transcript;
      }
      return transcript.trim();
    }

    function getCommandAfterWake(fullText) {
      let remainder = stripWakeWordPrefix(fullText);
      if (!remainder) return '';

      // Strip common leading filler words/punctuation so "[name], let's talk about..."
      // becomes "let's talk about..."
      remainder = remainder.replace(/^(hey|ok|okay|please|now|um|uh|so|well|lets|let us|can you|could you|would you|go ahead|talk about|tell me about)\s+/i, '').trim();

      // Bible ref normalization only when committing to Grok — not on live captions.
      remainder = normalizeBibleTranscript(remainder).trim();

      return remainder;
    }

    // Normalize common speech-to-text errors, especially Bible references like "1 John 4" (often "one john four", "first john four", "i john 4").
    // This helps both the sent command text and ref extraction.
    function normalizeBibleTranscript(text) {
      if (!text) return text;
      let t = ' ' + text + ' ';

      // Specific for common STT mishearing of 1 John 1 as "first john one" or "1 john one"
      t = t.replace(/\bfirst\s+john\s+one\b/gi, '1 John 1');
      t = t.replace(/\b1\s+john\s+one\b/gi, '1 John 1');

      // Do not rewrite "John too / as well / next" into a chapter — that sent the wrong book.

      // Direct rescue for the exact jumbled STT output the user is seeing on voice:
      // "John tell me about John two" comes out as "two John two cell", "second John 2 cell", "john two cell"
      t = t.replace(/\btwo\s+john\s+two\b/gi, 'John 2');
      t = t.replace(/\bsecond\s+john\s+two\b/gi, 'John 2');
      t = t.replace(/\b2\s+john\s+2\b/gi, 'John 2');
      t = t.replace(/\bjohn\s+two\s+cell\b/gi, 'John 2');
      t = t.replace(/\bcell\b/gi, ''); // strip common garbage that STT inserts after Bible refs
      t = t.replace(/\btwo\s+john\s+two\s+cell\b/gi, 'John 2');
      t = t.replace(/\bsecond\s+john\s+2\s+cell\b/gi, 'John 2');

      // Gospel of John references first ( "john one", "john 1", "john chapter one", "the book of john 1" etc.)
      // This must come before the epistle "one john" rules so "John one" becomes the Gospel, not 1 John.
      t = t.replace(/\b(john|the book of john|the gospel of john)\s*(chapter|ch\.?)?\s*(one|1|first)\b/gi, 'John 1');
      t = t.replace(/\b(john|the book of john|the gospel of john)\s*(chapter|ch\.?)?\s*(two|2|second)\b/gi, 'John 2');
      t = t.replace(/\b(john|the book of john|the gospel of john)\s*(chapter|ch\.?)?\s*(three|3|third)\b/gi, 'John 3');
      t = t.replace(/\b(john|the book of john|the gospel of john)\s*(chapter|ch\.?)?\s*(four|4)\b/gi, 'John 4');
      t = t.replace(/\b(john|the book of john|the gospel of john)\s*(chapter|ch\.?)?\s*(five|5)\b/gi, 'John 5');
      t = t.replace(/\b(john|the book of john|the gospel of john)\s*(chapter|ch\.?)?\s*(\d+)\b/gi, 'John $3');

      // Numbered books - very common STT mistakes for "1 John", "2 Peter" etc.
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

      // Fix word numbers for chapters/verses in refs (STT often says "four" instead of "4")
      t = t.replace(/\bchapter\s+(one|first)\b/gi, 'chapter 1');
      t = t.replace(/\bchapter\s+(two|second)\b/gi, 'chapter 2');
      t = t.replace(/\bchapter\s+(three|third)\b/gi, 'chapter 3');
      t = t.replace(/\bchapter\s+four\b/gi, 'chapter 4');
      t = t.replace(/\bchapter\s+five\b/gi, 'chapter 5');
      t = t.replace(/\bchapter\s+six\b/gi, 'chapter 6');
      t = t.replace(/\bchapter\s+seven\b/gi, 'chapter 7');
      t = t.replace(/\bchapter\s+eight\b/gi, 'chapter 8');
      t = t.replace(/\bchapter\s+nine\b/gi, 'chapter 9');
      t = t.replace(/\bchapter\s+ten\b/gi, 'chapter 10');

      t = t.replace(/\bverse\s+four\b/gi, 'verse 4');
      t = t.replace(/\bverse\s+five\b/gi, 'verse 5');

      // Specific fixes for the reported garble "4 four 1 john 4" etc. and common "1 john four"
      t = t.replace(/\b4\s+four\s+1\s+john\s+4\b/gi, '1 John 4');
      t = t.replace(/\bfour\s+1\s+john\s+4\b/gi, '1 John 4');
      t = t.replace(/\b1\s+john\s+four\b/gi, '1 John 4');
      t = t.replace(/\bfirst\s+john\s+four\b/gi, '1 John 4');
      t = t.replace(/\bone\s+john\s+four\b/gi, '1 John 4');
      t = t.replace(/\bi\s+john\s+four\b/gi, '1 John 4');

      // General "X four" -> "X 4" near john refs (helps extraction and model)
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

    // Convert a recorded audio Blob to base64 for the /api/stt proxy (keeps things simple, no extra deps).
    // We only do this for short committed utterances in hands-free mode.
    async function blobToBase64(blob) {
      return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => {
          const dataUrl = reader.result;
          // Strip the "data:...;base64," prefix
          const base64 = (dataUrl || '').split(',')[1] || '';
          resolve(base64);
        };
        reader.onerror = reject;
        reader.readAsDataURL(blob);
      });
    }

    // Optional: fetch a higher-quality transcript from xAI STT for a just-recorded utterance.
    // Falls back to the browser transcript if STT is slow, not configured, or fails.
    // Runs with a short timeout so voice input never feels slower than before.
    async function improveTranscriptWithSTT(fallbackText, audioBlob, timeoutMs = 3800) {
      if (!audioBlob || !fallbackText) return fallbackText;

      // Quick client-side guard: if /api/config said no STT, skip the roundtrip.
      // (We also check on the server.)
      try {
        const has = (typeof serverHasSTT !== 'undefined') ? serverHasSTT : true;
        if (!has) return fallbackText;
      } catch (e) {}

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);

      try {
        const b64 = await blobToBase64(audioBlob);
        const mime = audioBlob.type || 'audio/webm';

        const r = await fetch('/api/stt', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ audio: b64, mime, language: 'en' }),
          signal: controller.signal
        });

        clearTimeout(timer);

        if (!r.ok) {
          // Any failure from the STT proxy → permanently disable proxy path + hide live UI.
          window.__sttLiveDisabled = true;
          const liveC = document.getElementById('live-transcript-container');
          if (liveC) liveC.style.display = 'none';
          if (!window.__sttFailedLogged) {
            window.__sttFailedLogged = true;
            console.warn('[STT] xAI STT proxy unavailable (status ' + r.status + '). Using browser SpeechRecognition only for hands-free input.');
          }
          return fallbackText;
        }

        const data = await r.json();
        const improved = (data && data.text ? data.text : '').trim();
        if (improved && improved.length > 1) {
          // Keep the browser text as a very light fallback post-process if needed,
          // but the xAI result is usually dramatically better for Bible content.
          console.log('[STT] improved transcript (browser → xAI):', fallbackText.slice(0,80), '→', improved.slice(0,80));
          return improved;
        }
        return fallbackText;
      } catch (e) {
        clearTimeout(timer);
        if (e.name === 'AbortError') {
          console.log('[STT] timed out, using browser transcript');
        } else {
          console.warn('[STT] client error, using browser transcript:', e.message || e);
        }
        return fallbackText;
      }
    }

    // Extracted commit logic for hands-free wake-word gated turns.
    // Centralized so we can call it from the silence timer and from barge-in short timers.
    async function commitHandsFreeTranscript(finalText, conf) {
      stopListeningUI();
      if (recognition) {
        try { recognition.stop(); } catch (e) {}
      }

      // Give the MediaRecorder 'stop' event a moment to fire and populate lastUtteranceAudioBlob.
      // This is only for the rare case where stop was just called; in normal flow the onstop has usually run.
      if (lastUtteranceAudioBlob === null && audioChunks && audioChunks.length > 0) {
        await sleep(60);
      }

      // If we captured raw audio for this utterance (started when listening began),
      // ask the cheap xAI STT for a high-accuracy version. This is the main win:
      // better base text for Bible refs means the existing normalize + server grounding
      // succeed far more often ("John one" / "first John one" / "Romans 5" etc.).
      // We use a short timeout so it never makes voice input feel slower.
      // Prefer the live server-improved transcription (what the user sees in the accurate live box)
      // over the raw browser finalText. This ensures the AI gets the boosted accurate text.
      let textForCommit = currentTranscript || finalText;
      if (lastUtteranceAudioBlob) {
        try {
          textForCommit = await improveTranscriptWithSTT(textForCommit, lastUtteranceAudioBlob);
        } catch (e) {
          textForCommit = currentTranscript || finalText;
        }
        // Clear so we don't accidentally re-use the same clip on a restart
        lastUtteranceAudioBlob = null;
        audioChunks = [];
      }

      // === Wake-word gated commit ===
      // Prefer the accumulated pending text (built from raw browser SR) over a partial live caption.
      textForCommit = (finalText && finalText.trim()) || currentTranscript || textForCommit;
      textForCommit = normalizeBibleTranscript(textForCommit);
      let cmd = getCommandAfterWake(textForCommit);
      const recentlyWoke = Date.now() < wakeWordActiveUntil;

      if ((!cmd || cmd.length < 2) && recentlyWoke) {
        cmd = textForCommit.trim();
        wakeWordActiveUntil = 0;
      longPauseUntil = 0;
      }

      if (!cmd || cmd.length < 2) {
        if (recentlyWoke) wakeWordActiveUntil = 0;
        scheduleHandsFreeRestart(800);
        return;
      }

      // WebKit/Safari often reports confidence as 0. Treat 0/undefined as unknown, not "too low".
      const knownLowConfidence = typeof conf === 'number' && conf > 0 && conf < 0.48;
      if (cmd.length < 3 || knownLowConfidence) {
        scheduleHandsFreeRestart(800);
        return;
      }

      if (lastSpokenText) {
        const spoken = lastSpokenText.toLowerCase();
        const heard = cmd.toLowerCase();
        const isEcho = heard.length < 40 && (
          heard.includes(spoken.slice(0, 30)) ||
          spoken.includes(heard.slice(0, 20))
        );
        if (isEcho) {
          scheduleHandsFreeRestart(800);
          return;
        }
      }

      wakeWordActiveUntil = 0;
      longPauseUntil = 0;
      isAwaitingResponse = true;
      sendToGrok(cmd);
    }

    // Mic button behavior
    micBtn.addEventListener("click", () => {
      // User gesture — prime TTS so hands-free auto-speak works after the network round-trip (esp. iPhone).
      wakeSpeechEngine(true);
      if (handsFreeEnabled) {
        if (commitTimeout) { clearTimeout(commitTimeout); commitTimeout = null; }
        if (restartTimer) { clearTimeout(restartTimer); restartTimer = null; }
        window._srErrorShown = {}; // allow error messages again after user manually intervened

        if (isListening) {
          // Tapping the mic while a transcript is showing means "send this now"
          // (same as Send). Do not wait for wake-word strip or a silence timer.
          const leftover = (pendingTranscript || currentTranscript || '').trim();
          if (leftover.length > 1) consumeAndSendVoice(leftover);
          if (recognition) {
            try { recognition.stop(); } catch (e) {}
          }
        } else if (isSpeechOutputting() || (hostedAudio && !hostedAudio.paused)) {
          stopSpeaking();
          tapToTalkTurn = true;
          startListening();
        } else {
          // Explicit tap while hands-free: this turn sends without requiring "John".
          tapToTalkTurn = true;
          pendingTranscript = null;
          currentTranscript = '';
          wakeWordActiveUntil = 0;
          longPauseUntil = 0;
          startListening();
        }
      } else {
        if (isListening) {
          const leftover = (pendingTranscript || currentTranscript || '').trim();
          if (leftover.length > 1) consumeAndSendVoice(leftover);
          if (recognition) {
            try { recognition.stop(); } catch (e) {}
          }
        } else {
          tapToTalkTurn = true;
          startListening();
        }
      }
    });

    // Hold-to-talk for non-hands-free
    function enableHoldToTalk() {
      micBtn.addEventListener("mousedown", () => { if (!handsFreeEnabled && !isListening) startListening(); });
      micBtn.addEventListener("mouseup", () => { if (!handsFreeEnabled && isListening && recognition) recognition.stop(); });
      micBtn.addEventListener("mouseleave", () => { if (!handsFreeEnabled && isListening && recognition) recognition.stop(); });
      micBtn.addEventListener("touchstart", (e) => { e.preventDefault(); if (!handsFreeEnabled && !isListening) startListening(); });
      micBtn.addEventListener("touchend", (e) => { e.preventDefault(); if (!handsFreeEnabled && isListening && recognition) recognition.stop(); });
    }

    // ====================== UI EVENTS ======================
    sendBtn.addEventListener("click", () => {
      wakeSpeechEngine();  // ensure TTS is primed on the send gesture (the actual speak() happens async later)
      const text = userInput.value.trim();
      if (text) sendToGrok(text);
    });

    userInput.addEventListener("keypress", (e) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        wakeSpeechEngine();
        const text = userInput.value.trim();
        if (text) sendToGrok(text);
      }
    });

    stopBtn.addEventListener("click", stopSpeaking);
    voiceBtn.addEventListener('click', () => {
      wakeSpeechEngine();
      openVoiceSettings();
    });

    // Backdrop click to close voice modal
    const voiceModalEl = document.getElementById('voice-modal');
    if (voiceModalEl) {
      voiceModalEl.addEventListener('click', (e) => {
        if (e.target === voiceModalEl) voiceModalEl.style.display = 'none';
      });
    }

    if (sourcesBtn) {
      sourcesBtn.addEventListener('click', () => {
        const modal = document.getElementById('sources-modal');
        if (modal) modal.style.display = 'flex';
      });
    }

    // Backdrop click to close sources modal
    const sourcesModalEl = document.getElementById('sources-modal');
    if (sourcesModalEl) {
      sourcesModalEl.addEventListener('click', (e) => {
        if (e.target === sourcesModalEl) sourcesModalEl.style.display = 'none';
      });
    }

    const upgradeBtn = document.getElementById('upgrade-btn');
    if (upgradeBtn) {
      upgradeBtn.addEventListener('click', () => {
        const modal = document.getElementById('subscribe-modal');
        if (modal) {
          modal.style.display = 'flex';
          const token = getEffectiveAuthToken();
          const accountInfo = document.getElementById('account-info');
          const loginSection = document.getElementById('login-section');
          const emailEl = document.getElementById('account-email');
          const statusEl = document.getElementById('account-status');
          const modalTitle = modal.querySelector('h3');
          if (modalTitle) {
            modalTitle.textContent = token ? 'Account' : 'Log in';
          }

          if (token) {
            if (accountInfo) accountInfo.style.display = '';
            if (loginSection) loginSection.style.display = 'none';
            const setPwSection = document.getElementById('set-password-section');
            if (setPwSection) setPwSection.style.display = 'none';

            // Try to fetch status
            const lb = document.getElementById('logout-btn');
            if (lb) { lb.textContent = 'Log out'; lb.style.background = '#555'; lb.style.color = 'white'; }
            fetch('/api/me', { headers: { 'Authorization': 'Bearer ' + token } })
              .then(r => r.json())
              .then(data => {
                if (emailEl) emailEl.textContent = data.email || 'Logged in';
                if (statusEl) {
                  let txt = data.status || 'active';
                  if (data.trial_end) txt += ' (trial ends ' + new Date(data.trial_end).toLocaleDateString() + ')';
                  if (!data.access_granted) txt = 'Access revoked';
                  statusEl.textContent = txt;
                }
                const setPwSection = document.getElementById('set-password-section');
                if (setPwSection) {
                  setPwSection.style.display = data.has_password ? 'none' : '';
                }
                const setPwBtn = document.getElementById('set-password-btn');
                if (setPwBtn) {
                  setPwBtn.textContent = (data.has_password ? 'Change Password' : 'Set Password');
                }
              })
              .catch(() => {
                if (emailEl) emailEl.textContent = localStorage.getItem('user_email') || 'Logged in';
                if (statusEl) statusEl.textContent = 'Active';
                const setPwSection = document.getElementById('set-password-section');
                if (setPwSection) setPwSection.style.display = 'none';
              });
          } else {
            if (accountInfo) accountInfo.style.display = 'none';
            if (loginSection) loginSection.style.display = '';
            const setPwSection = document.getElementById('set-password-section');
            if (setPwSection) setPwSection.style.display = 'none';

            // Reset success message
            const loginSuccess = document.getElementById('modal-login-success');
            if (loginSuccess) loginSuccess.style.display = 'none';

            // Clear previous input if desired
            const loginEmailInput = document.getElementById('modal-login-email');
            if (loginEmailInput) loginEmailInput.value = '';
          }
        }
      });
    }

    // Update header "Account" button label for unauthenticated users (makes it obvious there's a login path)
    const upgradeBtnEl = document.getElementById('upgrade-btn');
    if (upgradeBtnEl) {
      if (!getEffectiveAuthToken()) {
        upgradeBtnEl.textContent = 'Log in';
      }
      // Optional: after successful login in the modal, we could change it back, but since page usually reloads on login it's fine
    }

    // Close button for Account modal (the modal had no way to close except logout or refresh)
    const closeAccountBtn = document.getElementById('close-account-btn');
    if (closeAccountBtn) {
      closeAccountBtn.addEventListener('click', () => {
        document.getElementById('subscribe-modal').style.display = 'none';
      });
    }

    // Handle password login from inside the Account modal
    const sendLoginBtn = document.getElementById('modal-send-login-btn');
    if (sendLoginBtn) {
      sendLoginBtn.addEventListener('click', async function() {
        const emailInput = document.getElementById('modal-login-email');
        const passInput = document.getElementById('modal-login-password');
        const successDiv = document.getElementById('modal-login-success');
        const email = emailInput ? emailInput.value.trim() : '';
        const password = passInput ? passInput.value : '';
        if (!email || !email.includes('@') || !password) {
          alert('Please enter email and password.');
          return;
        }
        try {
          sendLoginBtn.disabled = true;
          sendLoginBtn.textContent = 'Logging in...';
          const { res, data } = await apiPost('/api/login', { email, password });
          if (res.ok && data.token) {
            localStorage.setItem('auth_token', data.token);
            localStorage.setItem('user_email', data.email || email);
            if (successDiv) {
              successDiv.textContent = 'Logged in! Redirecting to app...';
              successDiv.style.display = 'block';
            }
            setTimeout(() => { window.location.href = '/app'; }, 600);
          } else {
            const errText = (data && data.error) || 'Login failed.';
            if (/no password set|no account with that email/i.test(errText)) {
              if (successDiv) {
                successDiv.textContent = 'No password on file — sending magic link instead...';
                successDiv.style.display = 'block';
              }
              try {
                const { res: magicRes, data: magicData } = await apiPost('/api/request-login', { email });
                if (successDiv) {
                  successDiv.textContent = (magicRes.ok && (magicData.message || 'Check your email for magic link.')) || (magicData.error || 'Could not send magic link.');
                }
              } catch (magicErr) {
                if (successDiv) successDiv.textContent = magicErr.message || 'Could not send magic link.';
              }
            } else {
              alert(errText || 'Login failed. Use magic link if no password set.');
            }
          }
        } catch (err) {
          alert(err.message || 'Network error. Please try again.');
        } finally {
          sendLoginBtn.disabled = false;
          sendLoginBtn.textContent = 'Log in with password';
        }
      });
    }

    // Magic link fallback from modal
    const modalMagicLink = document.getElementById('modal-use-magic-link');
    if (modalMagicLink) {
      modalMagicLink.addEventListener('click', async (e) => {
        e.preventDefault();
        const emailInput = document.getElementById('modal-login-email');
        const email = emailInput ? emailInput.value.trim() : '';
        if (!email) { alert('Enter email first'); return; }
        try {
          const { res, data } = await apiPost('/api/request-login', { email });
          alert((res.ok && (data.message || 'Check your email for magic link.')) || data.error || 'Could not send link.');
        } catch (err) {
          alert(err.message || 'Error sending link.');
        }
      });
    }

    // "Request login link" button inside the logged-in Account view (for convenience on other devices/browsers)
    const reqLoginFromAccountBtn = document.getElementById('request-login-from-account-btn');
    if (reqLoginFromAccountBtn) {
      reqLoginFromAccountBtn.addEventListener('click', () => {
        const accountInfo = document.getElementById('account-info');
        const loginSection = document.getElementById('login-section');
        if (accountInfo) accountInfo.style.display = 'none';
        if (loginSection) loginSection.style.display = '';
        const loginSuccess = document.getElementById('modal-login-success');
        if (loginSuccess) loginSuccess.style.display = 'none';
        const loginEmailInput = document.getElementById('modal-login-email');
        if (loginEmailInput) loginEmailInput.value = '';
      });
    }

    // Set / change password button (for magic-link logged in users to enable direct password login)
    const setPwBtn = document.getElementById('set-password-btn');
    if (setPwBtn) {
      setPwBtn.addEventListener('click', async () => {
        const input = document.getElementById('set-password-input');
        const msg = document.getElementById('set-password-msg');
        const password = input ? input.value : '';
        if (!password || password.length < 8) {
          if (msg) { msg.textContent = 'Password must be at least 8 characters.'; msg.style.color = '#c0392b'; msg.style.display = 'block'; }
          return;
        }
        const token = getEffectiveAuthToken();
        if (!token) { alert('Not logged in'); return; }
        try {
          setPwBtn.disabled = true;
          setPwBtn.textContent = 'Saving...';
          const res = await fetch('/api/set-password', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
            body: JSON.stringify({ password })
          });
          const data = await res.json();
          if (msg) {
            msg.textContent = data.message || (data.success ? 'Password saved!' : 'Failed');
            msg.style.color = data.success ? 'green' : '#c0392b';
            msg.style.display = 'block';
          }
          if (data.success && input) input.value = '';
          if (data.success) {
            const setPwSection = document.getElementById('set-password-section');
            if (setPwSection) setPwSection.style.display = 'none';
          }
        } catch (e) {
          if (msg) { msg.textContent = 'Error setting password.'; msg.style.color = '#c0392b'; msg.style.display = 'block'; }
        } finally {
          setPwBtn.disabled = false;
          setPwBtn.textContent = 'Set / Update Password';
        }
      });
    }

    // Also allow clicking the backdrop (the .modal itself) to close the account modal
    const accountModal = document.getElementById('subscribe-modal');
    if (accountModal) {
      accountModal.addEventListener('click', (e) => {
        if (e.target === accountModal) {
          accountModal.style.display = 'none';
        }
      });
    }

    // Global ESC key support for any open modal (good UX, consistent with modern apps)
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        const openModals = document.querySelectorAll('.modal[style*="flex"], .modal[style*="block"]');
        if (openModals.length > 0) {
          // close the last/top one
          openModals[openModals.length - 1].style.display = 'none';
        }
      }
    });

    // Logout (or for demo visitors, acts as trial signup CTA when Account opened in demo)
    const logoutBtn = document.getElementById('logout-btn');
    if (logoutBtn) {
      logoutBtn.addEventListener('click', () => {
        const tokenNow = getEffectiveAuthToken();
        if (!tokenNow) {
          // Demo visitor clicking the repurposed button
          document.getElementById('subscribe-modal').style.display = 'none';
          window.location.href = '/#signup';
          return;
        }
        localStorage.removeItem('auth_token');
        localStorage.removeItem('user_email');
        document.getElementById('subscribe-modal').style.display = 'none';
        alert('Logged out. Visit the landing page to log back in.');
        window.location.href = '/';
      });
    }

    // On load, if no token but we have old beta, clean it
    if (!getEffectiveAuthToken() && localStorage.getItem('beta_subscribed')) {
      // optional: localStorage.removeItem('beta_subscribed');
    }

    const policyLink = document.getElementById('policy-sources-link');
    if (policyLink) {
      policyLink.addEventListener('click', (e) => {
        e.preventDefault();
        const modal = document.getElementById('sources-modal');
        if (modal) modal.style.display = 'flex';
      });
    }

    // Sidebar Grok-like controls (New chat + live search)
    const sidebarNewBtn = document.getElementById('sidebar-new-chat-btn');
    if (sidebarNewBtn) {
      sidebarNewBtn.addEventListener('click', () => {
        createNewChat();
        renderSidebarChats(currentSearchTerm || '');
      });
    }

    const sidebarSearch = document.getElementById('sidebar-search');
    if (sidebarSearch) {
      sidebarSearch.addEventListener('input', (e) => {
        renderSidebarChats(e.target.value);
      });
    }

    // Hands-free toggle
    const handsFreeCheckbox = document.getElementById('handsfree-toggle');
    handsFreeCheckbox.checked = handsFreeEnabled;

    // Update label to show current wake word setting (preserve the checkbox element)
    function updateHandsFreeLabel() {
      const label = document.querySelector('label[for="handsfree-toggle"]');
      if (label) {
        const ww = getWakeWordDisplay();
        const isMobile = window.innerWidth <= 768;
        let textSpan = label.querySelector('.hf-text');
        if (!textSpan) {
          textSpan = document.createElement('span');
          textSpan.className = 'hf-text';
          label.appendChild(textSpan);
        }
        if (isMobile) {
          if (handsFreeEnabled && wakeWordEnabled && ww) {
            textSpan.textContent = ww;
          } else if (handsFreeEnabled) {
            textSpan.textContent = 'on';
          } else {
            textSpan.textContent = 'HF';
          }
        } else {
          let extra = '';
          if (handsFreeEnabled && wakeWordEnabled && ww) {
            extra = `(wakeword ${ww})`;
          } else if (handsFreeEnabled && !wakeWordEnabled) {
            extra = '(always)';
          }
          textSpan.textContent = 'handsfree' + (extra ? ' ' + extra : '');
        }
      }
    }

    function syncInputPlaceholder() {
      if (!userInput) return;
      const mobile = window.innerWidth <= 768;
      const ph = mobile
        ? (userInput.getAttribute('data-placeholder-mobile') || 'Ask AI, John about The Word...')
        : (userInput.getAttribute('data-placeholder-desktop') || userInput.placeholder);
      userInput.placeholder = ph;
    }

    updateHandsFreeLabel();
    syncInputPlaceholder();

    // On mobile + keyboard visible: hide policy/demo/live bars to make the message "read window" larger
    // (userInput is already declared earlier in the script — do not re-declare)
    const chatCont = document.querySelector('.chat-container');
    if (userInput && chatCont) {
      const toggleMobileKeyboardClass = () => {
        if (window.innerWidth <= 768) {
          if (document.activeElement === userInput) {
            chatCont.classList.add('mobile-keyboard');
            chatCont.classList.add('input-focused');
          } else {
            chatCont.classList.remove('mobile-keyboard');
            chatCont.classList.remove('input-focused');
          }
        }
      };
      userInput.addEventListener('focus', toggleMobileKeyboardClass);
      userInput.addEventListener('blur', () => {
        setTimeout(() => {
          chatCont.classList.remove('mobile-keyboard');
          chatCont.classList.remove('input-focused');
        }, 150);
      });
      window.addEventListener('resize', () => {
        if (window.innerWidth > 768) {
          chatCont.classList.remove('mobile-keyboard');
          chatCont.classList.remove('input-focused');
        }
        updateHandsFreeLabel();
        syncInputPlaceholder();
      });
    }

    handsFreeCheckbox.addEventListener('change', () => {
      handsFreeEnabled = handsFreeCheckbox.checked;
      localStorage.setItem('handsfree_enabled', handsFreeEnabled);

      if (commitTimeout) { clearTimeout(commitTimeout); commitTimeout = null; }
      if (restartTimer) { clearTimeout(restartTimer); restartTimer = null; }
      pendingTranscript = null;
      tapToTalkTurn = false;

      if (handsFreeEnabled) {
        continuousMode = true;
        micAllowed = true;
        micBtn.style.background = '#c9a227';
        micBtn.style.color = 'white';
        micBtn.title = "Click to interrupt (Hands-free active)";
        // Unlock speechSynthesis on this user gesture so later auto-speak after the AI reply works on iPhone.
        wakeSpeechEngine(true);
        if (!isListening) scheduleHandsFreeRestart(400);
      } else {
        continuousMode = false;
        micBtn.style.background = '#e8e0d5';
        micBtn.style.color = '#2c3e50';
        micBtn.title = "Click or hold to speak";
        // Hard-release getUserMedia tracks + recognition so the OS mic indicator clears.
        releaseMicrophoneHardware();
        isAwaitingResponse = false;
        wakeWordActiveUntil = 0;
        longPauseUntil = 0;
        window._srErrorShown = {}; // reset so helpful error messages can appear again next time
      }
      if (typeof updateHandsFreeLabel === 'function') {
        updateHandsFreeLabel();
      }
    });

    // ====================== CHAT HISTORY (multi-conversation persistence) ======================
    function loadChats() {
      try {
        chats = JSON.parse(localStorage.getItem('winc_chats') || '[]');
        // simple migration from very old single-conversation storage
        if (chats.length === 0) {
          const old = localStorage.getItem('winc_conversation');
          if (old) {
            try {
              const msgs = JSON.parse(old);
              if (Array.isArray(msgs) && msgs.length > 0) {
                const id = Date.now();
                chats.push({ id, title: 'Previous session', messages: msgs, updated: Date.now() });
                localStorage.removeItem('winc_conversation');
              }
            } catch (e) {}
          }
        }
      } catch (e) { chats = []; }
    }

    function saveChats() {
      try { localStorage.setItem('winc_chats', JSON.stringify(chats)); } catch (e) {}
    }

    function getCurrentChat() {
      return chats.find(c => c.id === currentChatId);
    }

    function updateChatTitleIfNeeded(chat) {
      if (!chat || chat.title !== 'New conversation') return;
      const firstUser = (chat.messages || []).find(m => m.role === 'user');
      if (firstUser) {
        let t = firstUser.content.trim().slice(0, 60);
        if (t.length === 60) t += '...';
        chat.title = t || 'Conversation';
        saveChats();
      }
    }

    // (removed old modal renderChatsList - now using sidebar)
    // function renderChatsList() {
    //   ... (old code removed to clean up dead references to removed #chats-modal)

    // (old dead renderChatsList body removed - was referencing removed #chats-modal)

    // Sidebar renderer for Grok-like experience (always visible list)
    let currentSearchTerm = '';
    function renderSidebarChats(filter = '') {
      const container = document.getElementById('sidebar-chats-list');
      if (!container) return;
      container.innerHTML = '';
      currentSearchTerm = filter.toLowerCase();

      const sorted = chats.slice().sort((a, b) => (b.updated || 0) - (a.updated || 0));
      const filtered = sorted.filter(chat => {
        const title = (chat.title || '').toLowerCase();
        const snippet = (chat.messages && chat.messages[0] ? chat.messages[0].content : '').toLowerCase();
        return !currentSearchTerm || title.includes(currentSearchTerm) || snippet.includes(currentSearchTerm);
      });

      if (filtered.length === 0) {
        const empty = document.createElement('div');
        empty.style.cssText = 'padding:12px 16px; color:#888; font-size:12px;';
        empty.textContent = currentSearchTerm ? 'No matches' : 'No conversations yet';
        container.appendChild(empty);
        return;
      }

      // Group like Grok: Today / Yesterday / Previous 7 days / Older
      function getGroupKey(ts) {
        if (!ts) return 'older';
        const d = new Date(ts);
        const now = new Date();
        const diff = Math.floor((now.getTime() - d.getTime()) / (1000 * 60 * 60 * 24));
        if (diff < 1) return 'today';
        if (diff < 2) return 'yesterday';
        if (diff <= 7) return 'week';
        return 'older';
      }
      const groups = { today: [], yesterday: [], week: [], older: [] };
      filtered.forEach(chat => {
        const key = getGroupKey(chat.updated);
        groups[key].push(chat);
      });

      const groupOrder = ['today', 'yesterday', 'week', 'older'];
      const groupLabels = {
        today: 'Today',
        yesterday: 'Yesterday',
        week: 'Previous 7 days',
        older: 'Older'
      };

      groupOrder.forEach(key => {
        const groupChats = groups[key];
        if (!groupChats || groupChats.length === 0) return;

        // group header
        const header = document.createElement('div');
        header.style.cssText = 'padding: 6px 12px 4px; font-size: 10px; font-weight: 600; color: #888; background: #111a24; border-bottom: 1px solid #2c3e50;';
        header.textContent = groupLabels[key];
        container.appendChild(header);

        groupChats.forEach(chat => {
          const item = document.createElement('div');
          item.className = 'chat-list-item' + (chat.id === currentChatId ? ' active' : '');
          item.dataset.chatId = chat.id;

          const dateStr = chat.updated ? new Date(chat.updated).toLocaleDateString(undefined, {month:'short', day:'numeric'}) : '';
          const title = chat.title || 'Untitled';

          item.innerHTML = `
            <div class="title" title="${title}">${title}</div>
            <div style="display:flex; align-items:center; gap:4px; font-size:10px; color:#888;">
              <span>${dateStr}</span>
              <button class="edit" title="Rename">✎</button>
              <button class="delete" title="Delete">×</button>
            </div>
          `;

          // Click to load (but not on buttons)
          item.addEventListener('click', (e) => {
            if (e.target.tagName === 'BUTTON') return;
            switchToChat(chat.id);
          });

          // Rename
          const editBtn = item.querySelector('.edit');
          editBtn.addEventListener('click', (e) => {
            e.stopImmediatePropagation();
            const titleDiv = item.querySelector('.title');
            const original = chat.title || '';
            const input = document.createElement('input');
            input.type = 'text';
            input.value = original;
            input.style.cssText = 'flex:1; background:#1a252f; color:#eee; border:1px solid #c9a227; border-radius:4px; padding:2px 4px; font-size:13px;';
            titleDiv.replaceWith(input);
            input.focus();
            input.select();

            const save = () => {
              const newTitle = input.value.trim() || 'Untitled';
              chat.title = newTitle;
              saveChats();
              renderSidebarChats(currentSearchTerm);
              if (chat.id === currentChatId) {
                updateHeaderForCurrentChat();
              }
            };
            input.addEventListener('blur', save);
            input.addEventListener('keydown', (ev) => {
              if (ev.key === 'Enter') { ev.preventDefault(); save(); }
              if (ev.key === 'Escape') { renderSidebarChats(currentSearchTerm); }
            });
          });

          // Delete
          const delBtn = item.querySelector('.delete');
          delBtn.addEventListener('click', (e) => {
            e.stopImmediatePropagation();
            if (confirm(`Delete "${chat.title || 'this chat'}"?`)) {
              chats = chats.filter(c => c.id !== chat.id);
              saveChats();
              if (currentChatId === chat.id) {
                if (chats.length > 0) {
                  switchToChat(chats.slice().sort((a,b)=>(b.updated||0)-(a.updated||0))[0].id);
                } else {
                  createNewChat();
                }
              } else {
                renderSidebarChats(currentSearchTerm);
              }
            }
          });

          container.appendChild(item);
        });
      });
    }

    // Add eye icon show/hide for password fields (set-password and any login passwords in modals)
    function addPasswordToggles() {
      const pwInputs = document.querySelectorAll('input[type="password"]');
      pwInputs.forEach(input => {
        if (input.parentElement && input.parentElement.classList.contains('password-wrapper')) return;

        const wrapper = document.createElement('span');
        wrapper.className = 'password-wrapper';
        input.parentNode.insertBefore(wrapper, input);
        wrapper.appendChild(input);

        const toggle = document.createElement('span');
        toggle.className = 'password-toggle';
        toggle.textContent = '🙈';
        toggle.setAttribute('aria-label', 'Show password');
        wrapper.appendChild(toggle);

        toggle.addEventListener('click', () => {
          if (input.type === 'password') {
            input.type = 'text';
            toggle.textContent = '👁';
            toggle.setAttribute('aria-label', 'Hide password');
          } else {
            input.type = 'password';
            toggle.textContent = '🙈';
            toggle.setAttribute('aria-label', 'Show password');
          }
        });
      });
    }

    // Sidebar collapse (Grok-like)
    function initSidebarCollapse() {
      const sidebar = document.getElementById('sidebar');
      const toggle = document.getElementById('sidebar-toggle');
      if (!sidebar || !toggle) return;

      const saved = localStorage.getItem('winc_sidebar_collapsed') === 'true';
      if (saved) {
        sidebar.classList.add('collapsed');
        toggle.textContent = '»';
      }

      toggle.addEventListener('click', (e) => {
        e.stopImmediatePropagation();
        sidebar.classList.toggle('collapsed');
        const isCollapsed = sidebar.classList.contains('collapsed');
        toggle.textContent = isCollapsed ? '»' : '«';
        localStorage.setItem('winc_sidebar_collapsed', isCollapsed ? 'true' : 'false');
      });

      // clicking the narrow bar expands it
      sidebar.addEventListener('click', () => {
        if (sidebar.classList.contains('collapsed')) {
          sidebar.classList.remove('collapsed');
          toggle.textContent = '«';
          localStorage.setItem('winc_sidebar_collapsed', 'false');
        }
      });

      // Mobile drawer support
      const mobileToggle = document.getElementById('mobile-sidebar-toggle');
      if (mobileToggle) {
        mobileToggle.addEventListener('click', (e) => {
          e.stopImmediatePropagation();
          const isOpen = sidebar.classList.toggle('open');
          document.body.classList.toggle('sidebar-open', isOpen);
        });
      }

      // On mobile, always start (and stay) with the chat list drawer closed so the main "read window"
      // (messages area + speak 🔊 buttons on replies and verses) gets the full iPhone width/height by default.
      function forceCloseMobileDrawer() {
        if (window.innerWidth <= 768 && sidebar) {
          sidebar.classList.remove('open');
          document.body.classList.remove('sidebar-open');
        }
      }
      forceCloseMobileDrawer();
      // In case of late layout or Safari quirks, double-check shortly after load
      setTimeout(forceCloseMobileDrawer, 50);
      setTimeout(forceCloseMobileDrawer, 300);

      // Close drawer when clicking backdrop or selecting a chat on mobile
      document.addEventListener('click', (e) => {
        if (window.innerWidth <= 768 && sidebar.classList.contains('open')) {
          if (!sidebar.contains(e.target) && !mobileToggle.contains(e.target)) {
            sidebar.classList.remove('open');
            document.body.classList.remove('sidebar-open');
          }
        }
      });

      // Close drawer after selecting a chat on mobile
      const chatsList = document.getElementById('sidebar-chats-list');
      if (chatsList) {
        chatsList.addEventListener('click', () => {
          if (window.innerWidth <= 768 && sidebar.classList.contains('open')) {
            sidebar.classList.remove('open');
            document.body.classList.remove('sidebar-open');
          }
        });
      }
    }

    function createNewChat() {
      const id = Date.now();
      const chat = {
        id,
        title: 'New conversation',
        messages: [],
        updated: Date.now()
      };
      chats.unshift(chat);
      currentChatId = id;
      saveChats();

      // reset any pending voice state
      if (commitTimeout) { clearTimeout(commitTimeout); commitTimeout = null; }
      pendingTranscript = null;
      restartTimer = null;
      isAwaitingResponse = false;
      longPauseUntil = 0;
      wakeWordActiveUntil = 0;

      // clear UI and conversation
      document.getElementById('messages').innerHTML = '';
      conversation = [];

      // show welcome only for brand new empty chats
      showWelcomeMessage();

      updateHeaderForCurrentChat();
      renderSidebarChats(currentSearchTerm || '');
      return chat;
    }

    function switchToChat(id) {
      const chat = chats.find(c => c.id === id);
      if (!chat) return;
      currentChatId = id;

      // reset pending voice state when switching chats
      if (commitTimeout) { clearTimeout(commitTimeout); commitTimeout = null; }
      pendingTranscript = null;
      restartTimer = null;
      isAwaitingResponse = false;
      longPauseUntil = 0;
      wakeWordActiveUntil = 0;

      const msgsEl = document.getElementById('messages');
      msgsEl.innerHTML = '';
      conversation = (chat.messages || []).slice();

      // re-render with share/speak buttons + sources when available
      let lastUserQuestion = '';
      conversation.forEach(msg => {
        const el = addMessage(msg.content, msg.role === 'user');
        if (msg.role === 'user') {
          lastUserQuestion = msg.content;
        } else if (msg.role === 'assistant') {
          attachAssistantMessageActions(el, msg.content, lastUserQuestion);

          if (msg.sources && msg.sources.length) {
            attachSourcesUI(el, msg.sources, msg.content);
          }
        }
      });

      updateHeaderForCurrentChat();
      saveChats(); // mark as recently used
      renderSidebarChats(currentSearchTerm || '');
    }

    function updateHeaderForCurrentChat() {
      const el = document.getElementById('current-chat-title');
      const mobileEl = document.querySelector('.mobile-chat-title');
      if (!el && !mobileEl) return;

      const chat = getCurrentChat();
      const titleText = chat ? (chat.title || 'Conversation') : '';

      if (el) {
        el.textContent = titleText;
        if (chat) {
          el.title = 'Click to rename • ' + new Date(chat.updated || Date.now()).toLocaleString();
          // make title clickable for rename (Grok-like) - desktop
          el.onclick = () => {
            const original = chat.title || '';
            const input = document.createElement('input');
            input.type = 'text';
            input.value = original;
            input.style.cssText = 'font-size:11px; background:#1a252f; color:#ddd; border:1px solid #c9a227; border-radius:3px; padding:1px 4px; width:140px;';
            el.replaceWith(input);
            input.focus();
            input.select();
            const save = () => {
              const newT = input.value.trim() || 'Untitled';
              chat.title = newT;
              saveChats();
              updateHeaderForCurrentChat();
              renderSidebarChats(currentSearchTerm || '');
            };
            input.onblur = save;
            input.onkeydown = (ev) => {
              if (ev.key === 'Enter') { ev.preventDefault(); save(); }
              if (ev.key === 'Escape') { updateHeaderForCurrentChat(); renderSidebarChats(currentSearchTerm || ''); }
            };
          };
        } else {
          el.onclick = null;
        }
      }

      if (mobileEl) {
        mobileEl.textContent = titleText;
      }
    }

    function showWelcomeMessage() {
      const welcome = `Hi — I'm John, an AI study tool, not a pastor. Test every answer against Scripture. Try John 1:14 or Psalm 136:1, or say John plus your question.`;

      const welcomeEl = addMessage(welcome, false);
      const speakWelcome = document.createElement("button");
      speakWelcome.className = "speak-btn";
      speakWelcome.textContent = "🔊";
      speakWelcome.onclick = () => speak(welcome);
      welcomeEl.appendChild(speakWelcome);
    }

    function autoSaveCurrentChat() {
      if (!currentChatId) return;
      const chat = getCurrentChat();
      if (!chat) return;
      chat.messages = conversation.slice();
      chat.updated = Date.now();
      updateChatTitleIfNeeded(chat);
      saveChats();
    }

    // ====================== INITIALIZATION ======================
    function init() {
      loadChats();

      if (!currentChatId || !getCurrentChat()) {
        if (chats.length > 0) {
          currentChatId = chats.slice().sort((a,b)=>(b.updated||0)-(a.updated||0))[0].id;
        } else {
          createNewChat();
        }
      }

      // load messages for current chat into memory
      const chat = getCurrentChat();
      if (chat) {
        conversation = (chat.messages || []).slice();
      }

      setupSpeechRecognition();

      updateHeaderForCurrentChat();
      renderSidebarChats(''); // render Grok-like sidebar on init
      initSidebarCollapse();
      initDarkMode();
      initMainTabs();
      initLibrary();
      initWakeWordPresets();
      syncWakeWordSettingsUI();
      addPasswordToggles();
      // Re-apply after dynamic modals (account, subscribe, login, etc.) may inject new password fields
      setTimeout(addPasswordToggles, 100);
      setTimeout(addPasswordToggles, 400);

      // Make TTS work on the first user click anywhere (send, mic, messages, etc.)
      // so you don't have to specifically open Voice Settings first.
      setupGlobalTTSWake();

      // Release mic when the tab/PWA is closed, frozen, or backgrounded.
      // Without this, hands-free leaves getUserMedia tracks open and the OS keeps the mic "connected".
      window.addEventListener('pagehide', suspendMicrophoneForLifecycle);
      window.addEventListener('beforeunload', suspendMicrophoneForLifecycle);
      window.addEventListener('freeze', suspendMicrophoneForLifecycle);
      window.addEventListener('pageshow', (e) => {
        // bfcache restore or normal show after pagehide
        resumeMicrophoneAfterLifecycle();
      });
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'hidden') {
          suspendMicrophoneForLifecycle();
        } else {
          resumeMicrophoneAfterLifecycle();
        }
      });

      if (handsFreeEnabled) {
        micBtn.style.background = '#c9a227';
        micBtn.style.color = 'white';
        micBtn.title = "Click to interrupt (Hands-free active)";
        wakeSpeechEngine();
        scheduleHandsFreeRestart(800);
      }

      // Learn server config (STT + optional legacy hosted TTS only).
      // Voice output is always browser window.speechSynthesis (no server voices, no xAI TTS).
      fetch('/api/health').then(r => r.json()).then(data => {
        serverHasManagedTTS = false; // voices are client-only now
        window.hasHostedTTS = !!data.hasHostedTTS;
        serverHasSTT = !!data.hasSTT;
        // Defensive: if any old premium toggle UI is still in DOM from prior builds, hide it.
        const premiumToggle = document.getElementById('premium-voices-toggle');
        if (premiumToggle && premiumToggle.parentElement) {
          premiumToggle.parentElement.style.display = 'none';
        }
        const hostedDiv = document.getElementById('hosted-voice-select')?.closest('div');
        if (hostedDiv && !window.hasHostedTTS) {
          hostedDiv.style.display = 'none';
        }
      }).catch(() => { serverHasManagedTTS = false; serverHasSTT = false; });

      synth.onvoiceschanged = scheduleVoiceListRefresh;
      scheduleVoiceListRefresh();

      // On startup ensure we are on local browser voices (the only supported path).
      if (localStorage.getItem('use_premium_voices') !== 'false') {
        localStorage.setItem('use_premium_voices', 'false');
      }
      if (voiceSettings.voiceSource !== 'local') {
        voiceSettings.voiceSource = 'local';
        localStorage.setItem('voice_source', 'local');
      }

      // Wire up the Save Settings button (this was missing — that's why nothing was saving!)
      const saveVoiceBtn = document.getElementById('save-voice-btn');
      if (saveVoiceBtn) {
        saveVoiceBtn.addEventListener('click', saveVoiceSettings);
      }

      const closeVoiceBtn = document.getElementById('close-voice-btn');
      if (closeVoiceBtn) {
        closeVoiceBtn.addEventListener('click', () => {
          document.getElementById('voice-modal').style.display = 'none';
        });
      }

      // Screen + conversation recorder (Chrome/Edge: share this tab + tab audio + mic)
      try {
        if (typeof mountChatRecorderUI === 'function') {
          window.__wicSessionRecorder = mountChatRecorderUI({
            button: document.getElementById('session-record-btn'),
          });
        }
      } catch (recErr) {
        console.warn('[chat-recorder] init failed', recErr);
      }

      // Welcome only for brand new empty chats
      const currentChat = getCurrentChat();
      const isEmptyNew = !currentChat || (currentChat.messages || []).length === 0;
      if (isEmptyNew) {
        const welcome = `Hi — I'm John, an AI study tool, not a pastor. Test every answer against Scripture. Try John 1:14 or Psalm 136:1, or say John plus your question.`;

        const welcomeEl = addMessage(welcome, false);
        const speakWelcome = document.createElement("button");
        speakWelcome.className = "speak-btn";
        speakWelcome.textContent = "🔊";
        speakWelcome.onclick = () => speak(welcome);
        welcomeEl.appendChild(speakWelcome);
      } else {
        // re-render the loaded chat's messages (with share/speak buttons)
        const msgsEl = document.getElementById('messages');
        msgsEl.innerHTML = '';
        let lastUserQuestion = '';
        conversation.forEach(msg => {
          const el = addMessage(msg.content, msg.role === 'user');
          if (msg.role === 'user') {
            lastUserQuestion = msg.content;
          } else if (msg.role === 'assistant') {
            attachAssistantMessageActions(el, msg.content, lastUserQuestion);

            if (msg.sources && msg.sources.length) {
              attachSourcesUI(el, msg.sources, msg.content);
            }
          }
        });
      }

      // Optional: show connection status
      fetch('/api/health').then(r => r.json()).then(d => {
        if (!d.hasKey) {
          addMessage("Server warning: No XAI_API_KEY configured on the server.", false);
        } else if (d.hasKey && d.xaiKeyLooksValid === false) {
          addMessage("Server warning: XAI_API_KEY is set but may be a placeholder or invalid. Chat may fail until the production key is updated in Render.", false);
        }
        if (typeof d.hasSTT === 'boolean') serverHasSTT = d.hasSTT;
      }).catch(() => {});

      // Load dynamic config (trial days, site URL) from server
      fetch('/api/config').then(r => r.json()).then(cfg => {
        if (cfg && typeof cfg.trialDays === 'number' && cfg.trialDays > 0) {
          TRIAL_DAYS = cfg.trialDays;
        }
        if (typeof cfg.hasSTT === 'boolean') {
          serverHasSTT = cfg.hasSTT;
        }
        if (cfg && typeof cfg.siteUrl === 'string' && cfg.siteUrl) {
          SITE_SHARE_URL = productionShareUrl(cfg.siteUrl.replace(/\/$/, ''));
        }
        enforceAuthRequired();
      }).catch(() => {
        enforceAuthRequired();
      });

      enforceAuthRequired();
      if (!getEffectiveAuthToken()) {
        showSignupPrompt();
      }
      handleAppDeepLinkHash();
    }

    function handleAppDeepLinkHash() {
      const hash = (location.hash || '').replace('#', '').toLowerCase();
      if (!hash) return;
      if (hash === 'settings') {
        setTimeout(() => openVoiceSettings(), 150);
      } else if (hash === 'sources') {
        setTimeout(() => {
          const modal = document.getElementById('sources-modal');
          if (modal) modal.style.display = 'flex';
        }, 150);
      }
    }

    init();
  
document.getElementById('chat-input-form')?.addEventListener('submit', (e) => {
  e.preventDefault();
});
document.getElementById('reload-system-voices')?.addEventListener('click', (e) => {
  e.preventDefault();
  reloadSystemVoices();
});
document.getElementById('unlock-all-voices-btn')?.addEventListener('click', () => unlockAllVoices());
document.getElementById('test-selected-voice-btn')?.addEventListener('click', () => testSelectedVoice());
document.getElementById('sources-modal-close')?.addEventListener('click', () => {
  const modal = document.getElementById('sources-modal');
  if (modal) modal.style.display = 'none';
});
