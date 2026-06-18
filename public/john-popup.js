/**
 * Embeddable "Ask AI" pop-out — text + voice on landing, help, and other pages.
 */
(function () {
  'use strict';

  const WELCOME = {
    demo: `Hi — ask AI, John. Ask about any passage, Greek or Hebrew word, or biblical theme. Responses are AI-generated — test them against Scripture. Type your question or tap the microphone to speak. Demo mode includes a limited number of responses.`,
    help: `Hi — ask AI, John. Need help using the app? Ask about voices, hands-free mode, the Library, Settings, installing the PWA, and more. Type or tap the microphone.`,
    sources: `Hi — ask AI, John. Ask about Sources & Data Attribution: bible.helloao.org, English translations (BSB, ASV, YLT, WEB), SBL Greek NT, Westminster Leningrad Codex Hebrew, how live citations work, Grok 4.3, browser voices, or how to verify verses. Type or tap the microphone.`
  };

  const POPUP_TITLES = {
    demo: '🎙️ Ask AI, John',
    help: '💬 Ask AI, John',
    sources: '📚 Ask AI, John — Sources'
  };

  let demoLimit = 10;
  let demoUsed = 0;
  let conversation = [];
  let isOpen = false;
  let isSending = false;
  let isListening = false;
  let recognition = null;
  let synth = window.speechSynthesis;
  let currentMode = 'demo';
  let initialized = false;

  function isDark() {
    return document.documentElement.getAttribute('data-theme') === 'dark';
  }

  function getAuthToken() {
    try {
      return localStorage.getItem('auth_token') || '';
    } catch (e) {
      return '';
    }
  }

  function syncDemoCounter() {
    const today = new Date().toISOString().slice(0, 10);
    try {
      if (localStorage.getItem('demo_last_date') !== today) {
        localStorage.setItem('demo_responses_used', '0');
        localStorage.setItem('demo_last_date', today);
      }
      demoUsed = parseInt(localStorage.getItem('demo_responses_used') || '0', 10);
    } catch (e) {
      demoUsed = 0;
    }
  }

  function bumpDemoCounter() {
    demoUsed++;
    try {
      localStorage.setItem('demo_responses_used', String(demoUsed));
    } catch (e) {}
    updateDemoStatus();
  }

  function getDefaultTrans() {
    try {
      const t = localStorage.getItem('default_english_trans') || 'BSB';
      return ['BSB', 'eng_asv', 'eng_ylt', 'ENGWEBP'].includes(t) ? t : 'BSB';
    } catch (e) {
      return 'BSB';
    }
  }

  function injectStyles() {
    if (document.getElementById('john-popup-styles')) return;
    const style = document.createElement('style');
    style.id = 'john-popup-styles';
    style.textContent = `
      .john-popup-overlay {
        position: fixed;
        inset: 0;
        background: rgba(0,0,0,0.55);
        z-index: 3000;
        display: none;
        align-items: flex-end;
        justify-content: center;
        padding: 12px;
        box-sizing: border-box;
      }
      .john-popup-overlay.open { display: flex; }
      .john-popup-panel {
        width: 100%;
        max-width: 420px;
        max-height: min(82vh, 560px);
        background: var(--john-popup-bg, #ffffff);
        color: var(--john-popup-text, #333);
        border-radius: 16px 16px 12px 12px;
        box-shadow: 0 12px 40px rgba(0,0,0,0.28);
        display: flex;
        flex-direction: column;
        overflow: hidden;
        border: 1px solid var(--john-popup-border, #e8d9c2);
      }
      html[data-theme="dark"] {
        --john-popup-bg: #1a222c;
        --john-popup-text: #e8e4dc;
        --john-popup-border: #3d5266;
        --john-popup-messages-bg: #141b24;
        --john-popup-user-bg: #3d5266;
        --john-popup-ai-bg: #243040;
        --john-popup-input-bg: #243040;
      }
      :root {
        --john-popup-bg: #ffffff;
        --john-popup-text: #333333;
        --john-popup-border: #e8d9c2;
        --john-popup-messages-bg: #fdfaf3;
        --john-popup-user-bg: #2c3e50;
        --john-popup-ai-bg: #e8e0d5;
        --john-popup-input-bg: #ffffff;
      }
      .john-popup-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: 12px 14px;
        background: linear-gradient(135deg, #2c3e50, #1a252f);
        color: #fff;
        flex-shrink: 0;
      }
      .john-popup-header h3 {
        margin: 0;
        font-size: 16px;
        font-weight: 700;
      }
      .john-popup-close {
        background: rgba(255,255,255,0.15);
        border: none;
        color: #fff;
        width: 32px;
        height: 32px;
        border-radius: 8px;
        font-size: 20px;
        cursor: pointer;
        line-height: 1;
      }
      .john-popup-close:hover { background: rgba(255,255,255,0.25); }
      .john-popup-messages {
        flex: 1;
        overflow-y: auto;
        padding: 14px;
        background: var(--john-popup-messages-bg);
        display: flex;
        flex-direction: column;
        gap: 10px;
        min-height: 200px;
      }
      .john-popup-msg {
        max-width: 92%;
        padding: 10px 12px;
        border-radius: 14px;
        font-size: 14px;
        line-height: 1.45;
        word-wrap: break-word;
      }
      .john-popup-msg.user {
        align-self: flex-end;
        background: var(--john-popup-user-bg);
        color: #f0ebe3;
        border-bottom-right-radius: 4px;
      }
      .john-popup-msg.assistant {
        align-self: flex-start;
        background: var(--john-popup-ai-bg);
        color: var(--john-popup-text);
        border-bottom-left-radius: 4px;
      }
      .john-popup-msg.loading { opacity: 0.7; font-style: italic; }
      .john-popup-msg-row {
        display: flex;
        align-items: flex-start;
        gap: 4px;
        align-self: flex-start;
        max-width: 100%;
      }
      .john-popup-speak {
        background: transparent;
        border: none;
        font-size: 16px;
        cursor: pointer;
        padding: 8px 4px;
        opacity: 0.75;
        flex-shrink: 0;
      }
      .john-popup-speak:hover { opacity: 1; }
      .john-popup-status {
        font-size: 11px;
        color: #c9a227;
        text-align: center;
        padding: 4px 10px 0;
        min-height: 16px;
      }
      .john-popup-input-row {
        display: flex;
        align-items: center;
        gap: 8px;
        padding: 10px 12px 12px;
        border-top: 1px solid var(--john-popup-border);
        background: var(--john-popup-bg);
        flex-shrink: 0;
      }
      .john-popup-mic {
        width: 44px;
        height: 44px;
        border-radius: 50%;
        border: none;
        background: #e8e0d5;
        color: #2c3e50;
        font-size: 20px;
        cursor: pointer;
        flex-shrink: 0;
        display: flex;
        align-items: center;
        justify-content: center;
      }
      html[data-theme="dark"] .john-popup-mic {
        background: #243040;
        color: #e8e4dc;
      }
      .john-popup-mic.listening {
        background: #c94e4e;
        color: #fff;
        animation: john-popup-pulse 1.5s infinite;
      }
      @keyframes john-popup-pulse {
        0% { box-shadow: 0 0 0 0 rgba(201, 78, 78, 0.45); }
        70% { box-shadow: 0 0 0 10px rgba(201, 78, 78, 0); }
        100% { box-shadow: 0 0 0 0 rgba(201, 78, 78, 0); }
      }
      .john-popup-input {
        flex: 1;
        padding: 10px 12px;
        font-size: 16px;
        border: 1px solid var(--john-popup-border);
        border-radius: 22px;
        background: var(--john-popup-input-bg);
        color: var(--john-popup-text);
        outline: none;
      }
      .john-popup-input:focus { border-color: #c9a227; }
      .john-popup-send {
        background: #c9a227;
        color: #1a252f;
        border: none;
        padding: 10px 16px;
        border-radius: 22px;
        font-weight: 700;
        font-size: 14px;
        cursor: pointer;
        flex-shrink: 0;
      }
      .john-popup-send:disabled { opacity: 0.5; cursor: not-allowed; }
      @media (min-width: 640px) {
        .john-popup-overlay { align-items: center; padding: 20px; }
        .john-popup-panel { border-radius: 16px; max-height: min(78vh, 580px); }
      }
    `;
    document.head.appendChild(style);
  }

  function ensureDOM() {
    if (document.getElementById('john-popup-overlay')) return;
    const overlay = document.createElement('div');
    overlay.id = 'john-popup-overlay';
    overlay.className = 'john-popup-overlay';
    overlay.setAttribute('role', 'presentation');
    overlay.innerHTML = `
      <div class="john-popup-panel" role="dialog" aria-labelledby="john-popup-title" aria-modal="true">
        <div class="john-popup-header">
          <h3 id="john-popup-title">🎙️ Ask AI, John</h3>
          <button type="button" class="john-popup-close" aria-label="Close chat">&times;</button>
        </div>
        <div class="john-popup-messages" id="john-popup-messages"></div>
        <div class="john-popup-status" id="john-popup-status"></div>
        <div class="john-popup-input-row">
          <button type="button" class="john-popup-mic" id="john-popup-mic" aria-label="Speak your question">🎤</button>
          <input type="text" class="john-popup-input" id="john-popup-input" placeholder="Ask AI, John…" autocomplete="off" name="john-popup-question">
          <button type="button" class="john-popup-send" id="john-popup-send">Send</button>
        </div>
      </div>
    `;
    document.body.appendChild(overlay);

    overlay.querySelector('.john-popup-close').addEventListener('click', close);
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) close();
    });
    document.getElementById('john-popup-send').addEventListener('click', () => {
      const input = document.getElementById('john-popup-input');
      if (input && input.value.trim()) submit(input.value.trim());
    });
    document.getElementById('john-popup-input').addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        const input = e.target;
        if (input.value.trim()) submit(input.value.trim());
      }
    });
    document.getElementById('john-popup-mic').addEventListener('click', toggleMic);

    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && isOpen) close();
    });
  }

  function setupRecognition() {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) return null;
    const rec = new SR();
    rec.continuous = false;
    rec.interimResults = true;
    rec.lang = 'en-US';
    rec.onresult = (event) => {
      let transcript = '';
      for (let i = event.resultIndex; i < event.results.length; i++) {
        transcript += event.results[i][0].transcript;
      }
      const input = document.getElementById('john-popup-input');
      if (input) input.value = transcript.trim();
      const isFinal = event.results[event.results.length - 1].isFinal;
      if (isFinal && transcript.trim()) {
        stopMic();
        submit(transcript.trim());
      }
    };
    rec.onerror = () => stopMic();
    rec.onend = () => {
      if (isListening) stopMic();
    };
    return rec;
  }

  function toggleMic() {
    if (isListening) {
      stopMic();
      return;
    }
    if (!recognition) {
      alert('Speech recognition is not supported in this browser. Please type your question.');
      return;
    }
    try {
      recognition.start();
      isListening = true;
      const btn = document.getElementById('john-popup-mic');
      if (btn) btn.classList.add('listening');
    } catch (e) {
      stopMic();
    }
  }

  function stopMic() {
    isListening = false;
    const btn = document.getElementById('john-popup-mic');
    if (btn) btn.classList.remove('listening');
    if (recognition) {
      try { recognition.stop(); } catch (e) {}
    }
  }

  function appendMessage(text, role, extra) {
    const container = document.getElementById('john-popup-messages');
    if (!container) return null;
    if (role === 'assistant' && extra !== 'loading') {
      const row = document.createElement('div');
      row.className = 'john-popup-msg-row';
      const msg = document.createElement('div');
      msg.className = 'john-popup-msg assistant';
      msg.textContent = text;
      const speakBtn = document.createElement('button');
      speakBtn.type = 'button';
      speakBtn.className = 'john-popup-speak';
      speakBtn.textContent = '🔊';
      speakBtn.title = 'Speak this reply';
      speakBtn.addEventListener('click', () => speakText(text));
      row.appendChild(msg);
      row.appendChild(speakBtn);
      container.appendChild(row);
      container.scrollTop = container.scrollHeight;
      return msg;
    }
    const el = document.createElement('div');
    el.className = `john-popup-msg ${role}${extra === 'loading' ? ' loading' : ''}`;
    el.textContent = text;
    container.appendChild(el);
    container.scrollTop = container.scrollHeight;
    return el;
  }

  function removeLoading() {
    const container = document.getElementById('john-popup-messages');
    if (!container) return;
    const loading = container.querySelector('.john-popup-msg.loading');
    if (loading) loading.remove();
  }

  function speakText(text) {
    if (!synth || !text) return;
    try { synth.cancel(); } catch (e) {}
    const u = new SpeechSynthesisUtterance(text.replace(/\s+/g, ' ').trim());
    u.rate = 0.95;
    const voices = synth.getVoices();
    const en = voices.find((v) => (v.lang || '').startsWith('en'));
    if (en) u.voice = en;
    synth.speak(u);
  }

  function updateDemoStatus() {
    const el = document.getElementById('john-popup-status');
    if (!el) return;
    const token = getAuthToken();
    if (token) {
      el.textContent = '';
      return;
    }
    const left = Math.max(0, demoLimit - demoUsed);
    el.textContent = left > 0
      ? `Demo: ${left} response${left === 1 ? '' : 's'} left`
      : 'Demo limit reached — start a free trial for full access';
    el.style.color = left === 0 ? '#c94e4e' : '#c9a227';
  }

  function setInputEnabled(enabled) {
    const input = document.getElementById('john-popup-input');
    const send = document.getElementById('john-popup-send');
    const mic = document.getElementById('john-popup-mic');
    if (input) input.disabled = !enabled;
    if (send) send.disabled = !enabled;
    if (mic) mic.disabled = !enabled;
  }

  function buildApiUserMessage(displayText) {
    if (currentMode === 'sources') {
      return `The user is asking about Sources & Data Attribution in The Word in Context app: ${displayText}\n\nAnswer using your knowledge of bible.helloao.org (live API, not baked-in text), BSB/ASV/YLT/WEB English translations, SBL Greek NT, Westminster Leningrad Codex Hebrew, how refs are detected and fetched, post-reply source scanning, Grok 4.3 via secure server proxy, browser-only TTS, and local chat storage. Be precise and cite source names.`;
    }
    if (currentMode === 'help') {
      return `The user is on the Help page and asks: ${displayText}\n\nAnswer about how to use The Word in Context: voices, hands-free wake word, Library, Settings, Sources, PWA install, chat sidebar, and mobile tips.`;
    }
    return displayText;
  }

  function updatePopupTitle() {
    const titleEl = document.getElementById('john-popup-title');
    if (titleEl) titleEl.textContent = POPUP_TITLES[currentMode] || POPUP_TITLES.demo;
  }

  async function submit(userText) {
    if (!userText || isSending) return;
    const token = getAuthToken();
    if (!token && demoUsed >= demoLimit) {
      appendMessage(`Demo limit reached (${demoLimit} responses). Start a free trial on the landing page for unlimited access.`, 'assistant');
      setInputEnabled(false);
      return;
    }

    isSending = true;
    setInputEnabled(false);
    const input = document.getElementById('john-popup-input');
    if (input) input.value = '';
    stopMic();

    appendMessage(userText, 'user');
    conversation.push({ role: 'user', content: buildApiUserMessage(userText) });
    const loadingEl = appendMessage('Thinking…', 'assistant', 'loading');

    if (!token) bumpDemoCounter();

    try {
      const headers = { 'Content-Type': 'application/json' };
      if (token) headers.Authorization = 'Bearer ' + token;

      const res = await fetch('/api/chat', {
        method: 'POST',
        headers,
        body: JSON.stringify({
          messages: conversation,
          defaultTranslation: getDefaultTrans()
        })
      });

      let data;
      const ct = res.headers.get('content-type') || '';
      if (ct.includes('application/json')) {
        data = await res.json();
      } else {
        throw new Error(`Server error (${res.status})`);
      }

      removeLoading();
      if (loadingEl && loadingEl.parentNode) loadingEl.remove();

      if (!res.ok) {
        const err = data?.error || `Error ${res.status}`;
        appendMessage(err, 'assistant');
        if (!token && res.status === 429 && typeof data.demoRemaining === 'number') {
          demoUsed = demoLimit - data.demoRemaining;
          try { localStorage.setItem('demo_responses_used', String(demoUsed)); } catch (e) {}
          updateDemoStatus();
        }
        conversation.pop();
        return;
      }

      const reply = data.reply || 'No response.';
      conversation.push({ role: 'assistant', content: reply });
      appendMessage(reply, 'assistant');

      if (!token && typeof data.demoRemaining === 'number') {
        demoUsed = demoLimit - data.demoRemaining;
        try { localStorage.setItem('demo_responses_used', String(demoUsed)); } catch (e) {}
      }
      updateDemoStatus();
      if (!token && demoUsed >= demoLimit) setInputEnabled(false);
    } catch (err) {
      removeLoading();
      if (loadingEl && loadingEl.parentNode) loadingEl.remove();
      appendMessage(err.message || 'Network error. Please try again.', 'assistant');
      conversation.pop();
    } finally {
      isSending = false;
      if (getAuthToken() || demoUsed < demoLimit) setInputEnabled(true);
      const inputEl = document.getElementById('john-popup-input');
      if (inputEl && isOpen) inputEl.focus();
    }
  }

  function resetChat() {
    conversation = [];
    const container = document.getElementById('john-popup-messages');
    if (container) container.innerHTML = '';
    const welcome = WELCOME[currentMode] || WELCOME.demo;
    appendMessage(welcome, 'assistant');
    setInputEnabled(getAuthToken() || demoUsed < demoLimit);
    updateDemoStatus();
  }

  function open(mode) {
    if (!initialized) init({ mode: mode || currentMode });
    const newMode = mode || currentMode;
    const modeChanged = newMode !== currentMode;
    currentMode = newMode;
    ensureDOM();
    syncDemoCounter();
    const overlay = document.getElementById('john-popup-overlay');
    if (!overlay) return;
    updatePopupTitle();
    if (!conversation.length || modeChanged) resetChat();
    else updateDemoStatus();
    overlay.classList.add('open');
    isOpen = true;
    document.body.style.overflow = 'hidden';
    const input = document.getElementById('john-popup-input');
    if (input) setTimeout(() => input.focus(), 80);
  }

  function close() {
    stopMic();
    try { synth.cancel(); } catch (e) {}
    const overlay = document.getElementById('john-popup-overlay');
    if (overlay) overlay.classList.remove('open');
    isOpen = false;
    document.body.style.overflow = '';
  }

  function init(options) {
    if (initialized) return;
    initialized = true;
    currentMode = (options && options.mode) || document.body.getAttribute('data-john-popup-mode') || 'demo';
    injectStyles();
    ensureDOM();
    recognition = setupRecognition();
    syncDemoCounter();

    fetch('/api/config').then((r) => r.json()).then((cfg) => {
      if (cfg && typeof cfg.demoLimit === 'number' && cfg.demoLimit > 0) {
        demoLimit = cfg.demoLimit;
        updateDemoStatus();
      }
    }).catch(() => {});

    document.querySelectorAll('[data-john-popup]').forEach((el) => {
      el.addEventListener('click', (e) => {
        e.preventDefault();
        const dismissSel = el.getAttribute('data-john-popup-dismiss');
        if (dismissSel) {
          const modal = document.querySelector(dismissSel);
          if (modal) modal.style.display = 'none';
        }
        const mode = el.getAttribute('data-john-popup-mode') || currentMode;
        open(mode);
      });
    });
  }

  window.JohnPopup = { init, open, close };
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => init());
  } else {
    init();
  }
})();