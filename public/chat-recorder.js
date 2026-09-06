/**
 * Chat session recorder — Q & A capture for The Word in Context.
 *
 * Contract (keep in sync with tests in lib/chat-recorder.test.js):
 * - Desktop Chrome/Edge: getDisplayMedia (this tab + tab audio for John’s voice) + optional
 *   mic. That path must stay unchanged. isSupported still means display-capture + MediaRecorder.
 * - iOS/iPadOS (same isIOSDevice pattern as public/index.html): never permanently disable
 *   #session-record-btn. getDisplayMedia is missing or unusable, so the primary Record action
 *   is a guided Control Center → Screen Recording flow (screen + speaker + mic = questions
 *   AND John’s spoken answers). Mic-only MediaRecorder is a clearly labeled secondary option
 *   and does not include John’s voice.
 * - Do not touch the talk-to-John mic / SpeechRecognition path (that is a different control).
 * - Mic permission denied on the secondary path: Settings → Safari/Chrome → Microphone.
 *
 * Best experience (Chrome / Edge desktop):
 *   1. Click Record
 *   2. Choose "Chrome Tab" → this tab (The Word in Context)
 *   3. Enable "Also share tab audio" so AI speechSynthesis is captured
 *   4. Allow microphone for your questions
 *
 * iPhone / iPad: Control Center Screen Recording (enable Microphone on long-press).
 * Firefox: screen works; tab audio varies.
 */
(function (global) {
  'use strict';

  const PREFERRED_MIME = [
    'video/webm;codecs=vp9,opus',
    'video/webm;codecs=vp8,opus',
    'video/webm;codecs=vp9',
    'video/webm',
    'video/mp4',
  ];

  const PREFERRED_AUDIO_MIME = ['audio/mp4', 'audio/aac', 'audio/webm'];

  function defaultNav() {
    return typeof navigator !== 'undefined' ? navigator : {};
  }

  /** Same pattern as isIOSDevice() in public/index.html (iPhone/iPad + iPadOS desktop UA). */
  function isIOSDevice(nav) {
    nav = nav || defaultNav();
    try {
      return (
        /iPad|iPhone|iPod/i.test(nav.userAgent || '') ||
        (nav.platform === 'MacIntel' && nav.maxTouchPoints > 1)
      );
    } catch (_) {
      return false;
    }
  }

  function hasMediaRecorder() {
    return typeof MediaRecorder !== 'undefined';
  }

  function canUseDisplayMedia(nav) {
    nav = nav || defaultNav();
    return !!(
      hasMediaRecorder() &&
      nav.mediaDevices &&
      typeof nav.mediaDevices.getDisplayMedia === 'function'
    );
  }

  function canUseAudioOnly(nav) {
    nav = nav || defaultNav();
    return !!(
      hasMediaRecorder() &&
      nav.mediaDevices &&
      typeof nav.mediaDevices.getUserMedia === 'function'
    );
  }

  /** Record control stays enabled on iOS even when getDisplayMedia is missing. */
  function shouldEnableRecordButton(nav) {
    nav = nav || defaultNav();
    return isIOSDevice(nav) || canUseDisplayMedia(nav);
  }

  function idleRecordButtonTitle(ios) {
    return ios
      ? 'Record session (iPhone)'
      : 'Record screen + conversation (Chrome recommended)';
  }

  function micDeniedMessage() {
    return (
      'Microphone access was denied. On iPhone: Settings → Safari (or Chrome) → Microphone, ' +
      'enable access for this site, then try again.'
    );
  }

  function pickMimeType() {
    if (typeof MediaRecorder === 'undefined') return '';
    for (const t of PREFERRED_MIME) {
      if (MediaRecorder.isTypeSupported(t)) return t;
    }
    return '';
  }

  function pickAudioMimeType(isTypeSupported) {
    const check =
      typeof isTypeSupported === 'function'
        ? isTypeSupported
        : (t) =>
            typeof MediaRecorder !== 'undefined' &&
            typeof MediaRecorder.isTypeSupported === 'function' &&
            MediaRecorder.isTypeSupported(t);
    for (const t of PREFERRED_AUDIO_MIME) {
      try {
        if (check(t)) return t;
      } catch (_) {}
    }
    return '';
  }

  function extensionForBlobType(type) {
    const t = type || '';
    if (t.includes('mp4')) return t.indexOf('audio/') === 0 ? 'm4a' : 'mp4';
    if (t.includes('aac')) return 'aac';
    if (t.includes('webm')) return 'webm';
    return t.indexOf('audio/') === 0 ? 'm4a' : 'webm';
  }

  function formatElapsed(ms) {
    const s = Math.floor(ms / 1000);
    const m = Math.floor(s / 60);
    const r = s % 60;
    return `${String(m).padStart(2, '0')}:${String(r).padStart(2, '0')}`;
  }

  function downloadBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.rel = 'noopener';
    document.body.appendChild(a);
    a.click();
    setTimeout(() => {
      try {
        URL.revokeObjectURL(url);
        a.remove();
      } catch (_) {}
    }, 2000);
  }

  function sessionGet(key) {
    try {
      return sessionStorage.getItem(key);
    } catch (_) {
      return null;
    }
  }

  function sessionSet(key, value) {
    try {
      sessionStorage.setItem(key, value);
    } catch (_) {}
  }

  class ChatSessionRecorder {
    constructor(opts = {}) {
      this.onState = typeof opts.onState === 'function' ? opts.onState : () => {};
      this.onError = typeof opts.onError === 'function' ? opts.onError : () => {};
      this.onTick = typeof opts.onTick === 'function' ? opts.onTick : () => {};

      this._displayStream = null;
      this._micStream = null;
      this._mixedStream = null;
      this._audioCtx = null;
      this._recorder = null;
      this._chunks = [];
      this._startedAt = 0;
      this._tickTimer = null;
      this._recording = false;
      this._hadTabAudio = false;
      this._hadMic = false;
      this._audioOnly = false;
    }

    get isRecording() {
      return this._recording;
    }

    get isAudioOnly() {
      return this._audioOnly;
    }

    /** True when the desktop screen + tab-audio capture path is available. */
    get isSupported() {
      return canUseDisplayMedia();
    }

    /**
     * Start screen + audio capture (desktop Chrome/Edge).
     * @param {{ includeMic?: boolean }} options
     */
    async start(options = {}) {
      if (this._recording) return;
      if (!this.isSupported) {
        throw new Error(
          'Screen recording is not supported in this browser. Use Chrome or Edge on desktop.'
        );
      }

      const includeMic = options.includeMic !== false;
      const mimeType = pickMimeType();

      // 1) Screen / current tab (video + optional tab audio for AI voice)
      let displayStream;
      try {
        displayStream = await navigator.mediaDevices.getDisplayMedia({
          video: {
            displaySurface: 'browser',
            frameRate: { ideal: 15, max: 24 },
            width: { ideal: 1280, max: 1920 },
            height: { ideal: 720, max: 1080 },
          },
          audio: {
            // Hint for tab/system audio — user must still check "Share tab audio" in Chrome
            echoCancellation: false,
            noiseSuppression: false,
            autoGainControl: false,
          },
          // Chrome 107+
          preferCurrentTab: true,
          selfBrowserSurface: 'include',
          systemAudio: 'include',
          monitorTypeSurfaces: 'exclude',
          surfaceSwitching: 'include',
        });
      } catch (e) {
        if (e && (e.name === 'NotAllowedError' || e.name === 'AbortError')) {
          throw new Error('Screen share was cancelled. Click Record again when ready.');
        }
        throw e;
      }

      this._displayStream = displayStream;
      this._hadTabAudio = displayStream.getAudioTracks().length > 0;
      this._audioOnly = false;

      // If user stops sharing from browser UI, end recording
      const vTrack = displayStream.getVideoTracks()[0];
      if (vTrack) {
        vTrack.addEventListener('ended', () => {
          if (this._recording) this.stop({ download: true }).catch(() => {});
        });
      }

      // 2) Microphone for your questions
      if (includeMic) {
        try {
          this._micStream = await navigator.mediaDevices.getUserMedia({
            audio: {
              echoCancellation: true,
              noiseSuppression: true,
              autoGainControl: true,
            },
            video: false,
          });
          this._hadMic = true;
        } catch (e) {
          this._micStream = null;
          this._hadMic = false;
          console.warn('[chat-recorder] mic denied — tab audio only', e);
        }
      }

      // 3) Mix audio tracks (tab TTS + mic) into one stream
      const videoTracks = displayStream.getVideoTracks();
      let audioTracks = [];

      const hasDisplayAudio = displayStream.getAudioTracks().length > 0;
      const hasMic = this._micStream && this._micStream.getAudioTracks().length > 0;

      if (hasDisplayAudio || hasMic) {
        try {
          const AudioCtx = window.AudioContext || window.webkitAudioContext;
          this._audioCtx = new AudioCtx();
          if (this._audioCtx.state === 'suspended') {
            await this._audioCtx.resume();
          }
          const dest = this._audioCtx.createMediaStreamDestination();

          if (hasDisplayAudio) {
            const src = this._audioCtx.createMediaStreamSource(
              new MediaStream(displayStream.getAudioTracks())
            );
            // Slightly lower tab level so mic is clear
            const g = this._audioCtx.createGain();
            g.gain.value = 0.9;
            src.connect(g);
            g.connect(dest);
          }
          if (hasMic) {
            const src = this._audioCtx.createMediaStreamSource(this._micStream);
            const g = this._audioCtx.createGain();
            g.gain.value = 1.0;
            src.connect(g);
            g.connect(dest);
          }
          audioTracks = dest.stream.getAudioTracks();
        } catch (mixErr) {
          console.warn('[chat-recorder] audio mix failed, using raw tracks', mixErr);
          audioTracks = [
            ...displayStream.getAudioTracks(),
            ...(this._micStream ? this._micStream.getAudioTracks() : []),
          ];
        }
      }

      this._mixedStream = new MediaStream([...videoTracks, ...audioTracks]);

      // 4) MediaRecorder
      const recOpts = mimeType ? { mimeType, videoBitsPerSecond: 2_500_000 } : { videoBitsPerSecond: 2_500_000 };
      try {
        this._recorder = new MediaRecorder(this._mixedStream, recOpts);
      } catch (e) {
        this._recorder = new MediaRecorder(this._mixedStream);
      }

      this._chunks = [];
      this._recorder.ondataavailable = (ev) => {
        if (ev.data && ev.data.size > 0) this._chunks.push(ev.data);
      };

      this._recorder.onerror = (ev) => {
        console.error('[chat-recorder] recorder error', ev);
        this.onError(new Error('Recording error — try again in Chrome.'));
      };

      this._recorder.start(1000); // timeslice so we keep data if tab crashes
      this._recording = true;
      this._startedAt = Date.now();
      this._tickTimer = setInterval(() => {
        this.onTick(Date.now() - this._startedAt);
      }, 250);

      this.onState({
        recording: true,
        hadTabAudio: this._hadTabAudio,
        hadMic: this._hadMic,
        audioOnly: false,
        mimeType: this._recorder.mimeType || mimeType || 'video/webm',
      });
    }

    /**
     * Secondary iOS path only: mic audio of the user’s questions.
     * Does not capture John’s spoken answers (no tab/speaker audio on iPhone).
     */
    async startMicOnly() {
      if (this._recording) return;
      if (!canUseAudioOnly()) {
        throw new Error(
          'Microphone recording is not available. Use Control Center → Screen Recording ' +
            'to capture this Q & A, including John’s voice.'
        );
      }

      let micStream;
      try {
        micStream = await navigator.mediaDevices.getUserMedia({ audio: true });
      } catch (e) {
        const name = e && e.name;
        if (name === 'NotAllowedError' || name === 'NotFoundError' || name === 'SecurityError') {
          throw new Error(micDeniedMessage());
        }
        throw e;
      }

      if (!micStream || !micStream.getAudioTracks().length) {
        throw new Error(micDeniedMessage());
      }

      this._micStream = micStream;
      this._hadMic = true;
      this._hadTabAudio = false;
      this._audioOnly = true;

      const mimeType = pickAudioMimeType();
      const recOpts = mimeType ? { mimeType } : {};
      try {
        this._recorder = new MediaRecorder(this._micStream, recOpts);
      } catch (e) {
        this._recorder = new MediaRecorder(this._micStream);
      }

      this._chunks = [];
      this._recorder.ondataavailable = (ev) => {
        if (ev.data && ev.data.size > 0) this._chunks.push(ev.data);
      };
      this._recorder.onerror = (ev) => {
        console.error('[chat-recorder] recorder error', ev);
        this.onError(new Error('Recording error — try Control Center Screen Recording instead.'));
      };

      try {
        this._recorder.start(1000);
      } catch (_) {
        this._recorder.start();
      }

      this._recording = true;
      this._startedAt = Date.now();
      this._tickTimer = setInterval(() => {
        this.onTick(Date.now() - this._startedAt);
      }, 250);

      this.onState({
        recording: true,
        hadTabAudio: false,
        hadMic: true,
        audioOnly: true,
        mimeType: this._recorder.mimeType || mimeType || 'audio/mp4',
      });
    }

    /**
     * Stop and optionally download the WebM/MP4/M4A file.
     * @returns {Promise<{ blob: Blob, filename: string }|null>}
     */
    async stop(options = {}) {
      const download = options.download !== false;
      const audioOnly = this._audioOnly;
      if (!this._recording && !this._recorder) {
        this._cleanupStreams();
        return null;
      }

      const blob = await new Promise((resolve) => {
        const rec = this._recorder;
        if (!rec || rec.state === 'inactive') {
          resolve(
            this._chunks.length
              ? new Blob(this._chunks, { type: this._chunks[0].type || (audioOnly ? 'audio/mp4' : 'video/webm') })
              : null
          );
          return;
        }
        rec.onstop = () => {
          const type = rec.mimeType || (audioOnly ? 'audio/mp4' : 'video/webm');
          resolve(this._chunks.length ? new Blob(this._chunks, { type }) : null);
        };
        try {
          rec.stop();
        } catch (_) {
          resolve(null);
        }
      });

      this._recording = false;
      if (this._tickTimer) {
        clearInterval(this._tickTimer);
        this._tickTimer = null;
      }
      this._cleanupStreams();

      this.onState({
        recording: false,
        hadTabAudio: this._hadTabAudio,
        hadMic: this._hadMic,
        audioOnly,
      });

      const minSize = audioOnly ? 50 : 1000;
      if (!blob || blob.size < minSize) {
        this.onError(
          new Error(
            audioOnly
              ? 'Recording was empty. Check the microphone and try again.'
              : 'Recording was empty. Try again and keep the share dialog open.'
          )
        );
        return null;
      }

      const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
      const ext = extensionForBlobType(blob.type);
      const filename = `word-in-context-session-${stamp}.${ext}`;

      if (download) downloadBlob(blob, filename);

      return {
        blob,
        filename,
        size: blob.size,
        hadTabAudio: this._hadTabAudio,
        hadMic: this._hadMic,
        audioOnly,
      };
    }

    _cleanupStreams() {
      const stopTracks = (stream) => {
        if (!stream) return;
        try {
          stream.getTracks().forEach((t) => {
            try {
              t.stop();
            } catch (_) {}
          });
        } catch (_) {}
      };
      stopTracks(this._displayStream);
      stopTracks(this._micStream);
      stopTracks(this._mixedStream);
      this._displayStream = null;
      this._micStream = null;
      this._mixedStream = null;
      this._recorder = null;
      this._chunks = [];
      this._audioOnly = false;
      if (this._audioCtx) {
        try {
          this._audioCtx.close();
        } catch (_) {}
        this._audioCtx = null;
      }
    }

    cancel() {
      this._recording = false;
      if (this._tickTimer) {
        clearInterval(this._tickTimer);
        this._tickTimer = null;
      }
      try {
        if (this._recorder && this._recorder.state !== 'inactive') this._recorder.stop();
      } catch (_) {}
      this._cleanupStreams();
      this.onState({ recording: false, audioOnly: false });
    }
  }

  function ensureIosGuideStyles() {
    if (typeof document === 'undefined') return;
    if (document.getElementById('session-record-ios-guide-css')) return;
    const style = document.createElement('style');
    style.id = 'session-record-ios-guide-css';
    style.textContent = `
      .session-record-ios-guide {
        position: fixed; inset: 0; z-index: 80;
        background: rgba(20, 12, 6, 0.62);
        display: flex; align-items: flex-end; justify-content: center;
        padding: 16px 12px calc(16px + env(safe-area-inset-bottom, 0px));
      }
      .session-record-ios-guide[hidden] { display: none !important; }
      .session-record-ios-card {
        width: min(440px, 100%);
        background: #2c1810; color: #f5e8d3;
        border: 1px solid #c9a227; border-radius: 16px;
        padding: 18px 16px 14px; box-shadow: 0 12px 40px rgba(0,0,0,0.35);
      }
      .session-record-ios-card h3 {
        margin: 0 0 8px; font-size: 17px; color: #f5e8d3;
      }
      .session-record-ios-card p,
      .session-record-ios-card li {
        margin: 0 0 8px; font-size: 14px; line-height: 1.45;
      }
      .session-record-ios-card ol { margin: 0 0 14px; padding-left: 1.2em; }
      .session-record-ios-card button {
        width: 100%; border-radius: 10px; padding: 11px 12px;
        font-size: 14px; font-weight: 600; cursor: pointer; margin-top: 8px;
      }
      .session-record-ios-primary {
        background: #c9a227; color: #1a1208; border: none;
      }
      .session-record-ios-secondary {
        background: transparent; color: #f5e8d3;
        border: 1px solid #8a7354;
        font-weight: 500;
      }
    `;
    document.head.appendChild(style);
  }

  /**
   * Wire UI: button + floating bar.
   * @param {{ button?: HTMLElement, statusEl?: HTMLElement }} els
   */
  function mountChatRecorderUI(els = {}) {
    const ios = isIOSDevice();

    const recorder = new ChatSessionRecorder({
      onState(state) {
        updateBar(state);
        if (btn) {
          btn.classList.toggle('recording', !!state.recording);
          btn.setAttribute('aria-pressed', state.recording ? 'true' : 'false');
          btn.title = state.recording
            ? 'Stop and download recording'
            : idleRecordButtonTitle(ios);
          btn.innerHTML = state.recording
            ? '<span class="rec-dot"></span> Stop'
            : '⏺ Record';
        }
      },
      onTick(ms) {
        if (timeEl) timeEl.textContent = formatElapsed(ms);
      },
      onError(err) {
        if (statusEl) {
          statusEl.textContent = err.message || String(err);
          statusEl.style.display = 'block';
        }
        try {
          console.error('[chat-recorder]', err);
        } catch (_) {}
      },
    });

    let btn = els.button || document.getElementById('session-record-btn');
    let bar = document.getElementById('session-record-bar');
    let timeEl = document.getElementById('session-record-time');
    let statusEl = els.statusEl || document.getElementById('session-record-hint');
    let stopBtn = document.getElementById('session-record-stop');
    let iosGuide = null;

    if (!bar) {
      bar = document.createElement('div');
      bar.id = 'session-record-bar';
      bar.className = 'session-record-bar';
      bar.hidden = true;
      bar.innerHTML = `
        <span class="session-record-live"><span class="rec-dot"></span> REC</span>
        <span id="session-record-time" class="session-record-time">00:00</span>
        <span id="session-record-hint" class="session-record-hint"></span>
        <button type="button" id="session-record-stop" class="session-record-stop">Stop &amp; download</button>
      `;
      const host =
        document.querySelector('.chat-bottom') ||
        document.querySelector('.chat-container') ||
        document.body;
      host.appendChild(bar);
      timeEl = bar.querySelector('#session-record-time');
      statusEl = bar.querySelector('#session-record-hint');
      stopBtn = bar.querySelector('#session-record-stop');
    }

    function updateBar(state) {
      if (!bar) return;
      bar.hidden = !state.recording;
      if (state.recording && statusEl) {
        if (state.audioOnly) {
          statusEl.textContent =
            'mic only — your questions, not John’s answers. For full Q & A use Control Center → Screen Recording';
        } else {
          const parts = [];
          if (state.hadTabAudio) parts.push('tab audio (AI voice)');
          else parts.push('no tab audio — re-share and enable “Share tab audio” for AI voice');
          if (state.hadMic) parts.push('mic on');
          else parts.push('mic off');
          statusEl.textContent = parts.join(' · ');
        }
        statusEl.style.display = 'inline';
      }
    }

    function hideIosGuide() {
      if (iosGuide) iosGuide.hidden = true;
    }

    function showIosGuide() {
      ensureIosGuideStyles();
      if (!iosGuide) {
        iosGuide = document.createElement('div');
        iosGuide.id = 'session-record-ios-guide';
        iosGuide.className = 'session-record-ios-guide';
        iosGuide.hidden = true;
        iosGuide.setAttribute('role', 'dialog');
        iosGuide.setAttribute('aria-modal', 'true');
        iosGuide.setAttribute('aria-labelledby', 'session-record-ios-title');
        iosGuide.innerHTML = `
          <div class="session-record-ios-card">
            <h3 id="session-record-ios-title">Record this Q &amp; A on iPhone</h3>
            <p>Safari cannot record John’s voice in-app. Use iOS Screen Recording so the video includes the screen, the speaker (John’s answers), and your microphone (your questions).</p>
            <ol>
              <li>Swipe to open <strong>Control Center</strong> (down from the top-right, or up from the bottom on older iPhones).</li>
              <li>Touch and hold <strong>Screen Recording</strong>, turn <strong>Microphone</strong> on, then tap Start Recording.</li>
              <li>Return here and talk with John — questions and his spoken answers are both captured.</li>
              <li>Open Control Center and tap the red status to stop. The video saves to Photos.</li>
            </ol>
            <button type="button" class="session-record-ios-primary" id="session-record-ios-gotit">Got it — I’ll use Screen Recording</button>
            <button type="button" class="session-record-ios-secondary" id="session-record-ios-miconly">Record microphone only (your questions, not John’s answers)</button>
          </div>
        `;
        document.body.appendChild(iosGuide);
        iosGuide.addEventListener('click', (e) => {
          if (e.target === iosGuide) hideIosGuide();
        });
        const gotIt = iosGuide.querySelector('#session-record-ios-gotit');
        const micOnly = iosGuide.querySelector('#session-record-ios-miconly');
        if (gotIt) {
          gotIt.addEventListener('click', (e) => {
            e.preventDefault();
            hideIosGuide();
          });
        }
        if (micOnly) {
          micOnly.addEventListener('click', (e) => {
            e.preventDefault();
            hideIosGuide();
            startSecondaryMicOnly();
          });
        }
      }
      iosGuide.hidden = false;
      const focusBtn = iosGuide.querySelector('#session-record-ios-gotit');
      if (focusBtn) {
        try {
          focusBtn.focus();
        } catch (_) {}
      }
    }

    async function finishRecording() {
      const result = await recorder.stop({ download: true });
      if (result && statusEl) {
        statusEl.style.display = 'block';
        statusEl.textContent = `Saved ${result.filename} (${Math.round(result.size / 1024)} KB)`;
      }
    }

    async function startSecondaryMicOnly() {
      try {
        await recorder.startMicOnly();
      } catch (e) {
        recorder.onError(e);
        if (typeof alert === 'function') {
          alert(e.message || String(e));
        }
      }
    }

    async function toggle() {
      if (recorder.isRecording) {
        await finishRecording();
        return;
      }

      // iPhone / iPad: keep Record alive. Prefer getDisplayMedia if it unexpectedly works;
      // otherwise guide Control Center Screen Recording (full Q & A). Mic-only is secondary.
      if (ios) {
        if (canUseDisplayMedia()) {
          try {
            await recorder.start({ includeMic: true });
            return;
          } catch (e) {
            showIosGuide();
            return;
          }
        }
        showIosGuide();
        return;
      }

      if (!recorder.isSupported) {
        alert(
          'Screen + audio recording needs Chrome or Edge on a computer.\n\n' +
            'On iPhone, tap Record for steps to use Control Center → Screen Recording ' +
            '(captures your questions and John’s voice).'
        );
        return;
      }

      // First-time tip (desktop Chrome/Edge)
      const tipKey = 'wic_record_tip_v1';
      if (!sessionGet(tipKey)) {
        sessionSet(tipKey, '1');
        alert(
          'Record this study session (screen + sound)\n\n' +
            '1. In the share dialog pick “Chrome Tab” (or this window)\n' +
            '2. Select The Word in Context tab\n' +
            '3. Turn ON “Also share tab audio” so AI replies are recorded\n' +
            '4. Allow the microphone for your questions\n\n' +
            'When finished, click Stop — the video downloads to your computer.'
        );
      }

      try {
        await recorder.start({ includeMic: true });
      } catch (e) {
        recorder.onError(e);
      }
    }

    if (btn) {
      btn.addEventListener('click', (e) => {
        e.preventDefault();
        toggle();
      });
      btn.title = idleRecordButtonTitle(ios);
      if (!shouldEnableRecordButton()) {
        btn.disabled = true;
        btn.title = 'Recording not supported in this browser';
      } else {
        btn.disabled = false;
      }
    }
    if (stopBtn) {
      stopBtn.addEventListener('click', (e) => {
        e.preventDefault();
        if (recorder.isRecording) toggle();
      });
    }

    return recorder;
  }

  const ChatRecorderHelpers = {
    isIOSDevice,
    canUseDisplayMedia,
    canUseAudioOnly,
    shouldEnableRecordButton,
    idleRecordButtonTitle,
    micDeniedMessage,
    pickAudioMimeType,
    pickMimeType,
    extensionForBlobType,
    PREFERRED_AUDIO_MIME,
  };

  global.ChatSessionRecorder = ChatSessionRecorder;
  global.mountChatRecorderUI = mountChatRecorderUI;
  global.ChatRecorderHelpers = ChatRecorderHelpers;
})(typeof window !== 'undefined' ? window : globalThis);
