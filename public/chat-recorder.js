/**
 * Chat session recorder — screen (or current tab) + conversation audio.
 *
 * Best experience (Chrome / Edge desktop):
 *   1. Click Record
 *   2. Choose "Chrome Tab" → this tab (The Word in Context)
 *   3. Enable "Also share tab audio" so AI speechSynthesis is captured
 *   4. Allow microphone for your questions
 *
 * Safari / iOS: limited or unsupported. Firefox: screen works; tab audio varies.
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

  function pickMimeType() {
    if (typeof MediaRecorder === 'undefined') return '';
    for (const t of PREFERRED_MIME) {
      if (MediaRecorder.isTypeSupported(t)) return t;
    }
    return '';
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
    }

    get isRecording() {
      return this._recording;
    }

    get isSupported() {
      return !!(
        navigator.mediaDevices &&
        typeof navigator.mediaDevices.getDisplayMedia === 'function' &&
        typeof MediaRecorder !== 'undefined'
      );
    }

    /**
     * Start screen + audio capture.
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
        mimeType: this._recorder.mimeType || mimeType || 'video/webm',
      });
    }

    /**
     * Stop and optionally download the WebM/MP4 file.
     * @returns {Promise<{ blob: Blob, filename: string }|null>}
     */
    async stop(options = {}) {
      const download = options.download !== false;
      if (!this._recording && !this._recorder) {
        this._cleanupStreams();
        return null;
      }

      const blob = await new Promise((resolve) => {
        const rec = this._recorder;
        if (!rec || rec.state === 'inactive') {
          resolve(
            this._chunks.length
              ? new Blob(this._chunks, { type: this._chunks[0].type || 'video/webm' })
              : null
          );
          return;
        }
        rec.onstop = () => {
          const type = rec.mimeType || 'video/webm';
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

      this.onState({ recording: false, hadTabAudio: this._hadTabAudio, hadMic: this._hadMic });

      if (!blob || blob.size < 1000) {
        this.onError(new Error('Recording was empty. Try again and keep the share dialog open.'));
        return null;
      }

      const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
      const ext = (blob.type || '').includes('mp4') ? 'mp4' : 'webm';
      const filename = `word-in-context-session-${stamp}.${ext}`;

      if (download) downloadBlob(blob, filename);

      return { blob, filename, size: blob.size, hadTabAudio: this._hadTabAudio, hadMic: this._hadMic };
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
      this.onState({ recording: false });
    }
  }

  /**
   * Wire UI: button + floating bar.
   * @param {{ button?: HTMLElement, statusEl?: HTMLElement }} els
   */
  function mountChatRecorderUI(els = {}) {
    const recorder = new ChatSessionRecorder({
      onState(state) {
        updateBar(state);
        if (btn) {
          btn.classList.toggle('recording', !!state.recording);
          btn.setAttribute('aria-pressed', state.recording ? 'true' : 'false');
          btn.title = state.recording
            ? 'Stop and download recording'
            : 'Record screen + conversation (Chrome recommended)';
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
        const parts = [];
        if (state.hadTabAudio) parts.push('tab audio (AI voice)');
        else parts.push('no tab audio — re-share and enable “Share tab audio” for AI voice');
        if (state.hadMic) parts.push('mic on');
        else parts.push('mic off');
        statusEl.textContent = parts.join(' · ');
        statusEl.style.display = 'inline';
      }
    }

    async function toggle() {
      if (!recorder.isSupported) {
        alert(
          'Screen + audio recording needs Chrome or Edge on a computer.\n\n' +
            'On iPhone/Safari this is not fully available.'
        );
        return;
      }

      if (recorder.isRecording) {
        const result = await recorder.stop({ download: true });
        if (result && statusEl) {
          statusEl.style.display = 'block';
          statusEl.textContent = `Saved ${result.filename} (${Math.round(result.size / 1024)} KB)`;
        }
        return;
      }

      // First-time tip
      const tipKey = 'wic_record_tip_v1';
      if (!sessionStorage.getItem(tipKey)) {
        sessionStorage.setItem(tipKey, '1');
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
      if (!recorder.isSupported) {
        btn.disabled = true;
        btn.title = 'Recording not supported in this browser';
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

  global.ChatSessionRecorder = ChatSessionRecorder;
  global.mountChatRecorderUI = mountChatRecorderUI;
})(typeof window !== 'undefined' ? window : globalThis);
