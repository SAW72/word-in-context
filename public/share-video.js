/**
 * Scripture voice-over video for social share.
 * Renders a vertical (9:16) canvas with verse text + optional narration audio, then
 * records via MediaRecorder for Messages / Facebook / download.
 */
(function (global) {
  'use strict';

  const W = 1080;
  const H = 1920;
  const MAX_DURATION_SEC = 120;

  function pickRecorderMime() {
    if (typeof MediaRecorder === 'undefined') return '';
    const candidates = [
      'video/mp4',
      'video/webm;codecs=vp9,opus',
      'video/webm;codecs=vp8,opus',
      'video/webm;codecs=vp9',
      'video/webm;codecs=vp8',
      'video/webm'
    ];
    for (const t of candidates) {
      try {
        if (MediaRecorder.isTypeSupported(t)) return t;
      } catch (e) { /* ignore */ }
    }
    return '';
  }

  function wrapLines(ctx, text, maxWidth) {
    const words = String(text || '').split(/\s+/).filter(Boolean);
    const lines = [];
    let line = '';
    for (const word of words) {
      const test = line ? `${line} ${word}` : word;
      if (ctx.measureText(test).width <= maxWidth) {
        line = test;
      } else {
        if (line) lines.push(line);
        line = word;
      }
    }
    if (line) lines.push(line);
    return lines;
  }

  function splitIntoPages(ctx, verses, maxWidth, maxLines) {
    const pages = [];
    let current = [];
    let lineCount = 0;

    for (const v of verses) {
      const body = wrapLines(ctx, `${v.number}  ${v.text}`, maxWidth);
      const need = body.length + 1;
      if (current.length && lineCount + need > maxLines) {
        pages.push(current);
        current = [];
        lineCount = 0;
      }
      current.push({ number: v.number, lines: body });
      lineCount += need;
    }
    if (current.length) pages.push(current);
    return pages.length ? pages : [[]];
  }

  function drawBackground(ctx) {
    const g = ctx.createLinearGradient(0, 0, 0, H);
    g.addColorStop(0, '#1a1510');
    g.addColorStop(0.45, '#2a2118');
    g.addColorStop(1, '#12100e');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, H);

    const radial = ctx.createRadialGradient(W * 0.5, H * 0.28, 40, W * 0.5, H * 0.35, W * 0.7);
    radial.addColorStop(0, 'rgba(201, 162, 39, 0.18)');
    radial.addColorStop(1, 'rgba(201, 162, 39, 0)');
    ctx.fillStyle = radial;
    ctx.fillRect(0, 0, W, H);

    ctx.strokeStyle = 'rgba(201, 162, 39, 0.45)';
    ctx.lineWidth = 4;
    ctx.strokeRect(48, 48, W - 96, H - 96);
    ctx.strokeStyle = 'rgba(201, 162, 39, 0.2)';
    ctx.lineWidth = 1;
    ctx.strokeRect(64, 64, W - 128, H - 128);
  }

  function drawFrame(ctx, {
    reference,
    translation,
    pages,
    pageIndex,
    progress,
    siteUrl
  }) {
    drawBackground(ctx);

    ctx.fillStyle = '#c9a227';
    ctx.font = '600 28px system-ui, -apple-system, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('THE WORD IN CONTEXT', W / 2, 130);

    ctx.fillStyle = '#f5efe3';
    ctx.font = '600 56px Georgia, "Times New Roman", serif';
    const refLines = wrapLines(ctx, reference, W - 160);
    let y = 230;
    refLines.forEach((ln) => {
      ctx.fillText(ln, W / 2, y);
      y += 64;
    });

    if (translation) {
      ctx.fillStyle = 'rgba(201, 162, 39, 0.9)';
      ctx.font = '500 30px system-ui, -apple-system, sans-serif';
      ctx.fillText(translation, W / 2, y + 8);
      y += 56;
    }

    ctx.strokeStyle = 'rgba(201, 162, 39, 0.35)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(W * 0.28, y + 10);
    ctx.lineTo(W * 0.72, y + 10);
    ctx.stroke();
    y += 70;

    const page = pages[Math.min(pageIndex, pages.length - 1)] || [];
    ctx.textAlign = 'left';
    ctx.fillStyle = '#f0ebe3';
    const left = 120;

    page.forEach((block) => {
      ctx.font = 'italic 400 40px Georgia, "Times New Roman", serif';
      block.lines.forEach((ln) => {
        if (y > H - 280) return;
        ctx.fillText(ln, left, y);
        y += 56;
      });
      y += 28;
    });

    const barY = H - 200;
    const barX = 140;
    const barW = W - 280;
    ctx.fillStyle = 'rgba(255,255,255,0.12)';
    ctx.fillRect(barX, barY, barW, 8);
    ctx.fillStyle = '#c9a227';
    const p = Number.isFinite(progress) ? Math.max(0, Math.min(1, progress)) : 0;
    ctx.fillRect(barX, barY, p * barW, 8);

    ctx.textAlign = 'center';
    ctx.fillStyle = 'rgba(240, 235, 227, 0.65)';
    ctx.font = '400 26px system-ui, -apple-system, sans-serif';
    ctx.fillText(siteUrl || 'thewordincontext.org', W / 2, H - 130);
    if (pages.length > 1) {
      ctx.fillStyle = 'rgba(201, 162, 39, 0.75)';
      ctx.font = '500 24px system-ui, -apple-system, sans-serif';
      ctx.fillText(`${pageIndex + 1} / ${pages.length}`, W / 2, H - 90);
    }
  }

  async function decodeAudio(arrayBuffer) {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return null;
    const ctx = new Ctx();
    try {
      const copy = arrayBuffer.slice(0);
      const buffer = await ctx.decodeAudioData(copy);
      if (!buffer || !Number.isFinite(buffer.duration) || buffer.duration <= 0) {
        try { await ctx.close(); } catch (e) {}
        return null;
      }
      return { ctx, buffer };
    } catch (e) {
      try { await ctx.close(); } catch (e2) {}
      return null;
    }
  }

  function estimateDurationSec(text) {
    const words = String(text || '').trim().split(/\s+/).filter(Boolean).length;
    return Math.max(4, Math.min(MAX_DURATION_SEC, (words / 140) * 60 + 1.5));
  }

  function safeDuration(seconds, fallbackText) {
    let d = Number(seconds);
    if (!Number.isFinite(d) || d <= 0) {
      d = estimateDurationSec(fallbackText);
    }
    return Math.max(3, Math.min(MAX_DURATION_SEC, d));
  }

  function wait(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function createRecorder(stream, mimeType) {
    // Prefer explicit mime; fall back to browser default if construction fails.
    try {
      if (mimeType) {
        return new MediaRecorder(stream, {
          mimeType,
          videoBitsPerSecond: 2_500_000
        });
      }
    } catch (e) { /* try default */ }
    try {
      return new MediaRecorder(stream, { videoBitsPerSecond: 2_500_000 });
    } catch (e2) {
      try {
        return new MediaRecorder(stream);
      } catch (e3) {
        throw new Error('This browser cannot record video. Try Safari on a newer iPhone, or share as text.');
      }
    }
  }

  /**
   * Wall-clock animation loop (setTimeout), not only rAF.
   * rAF pauses when the tab is backgrounded or Safari throttles, which made
   * recording appear stuck forever on "Recording video…".
   */
  function runTimedLoop({ durationSec, signal, onTick }) {
    return new Promise((resolve, reject) => {
      const t0 = performance.now();
      let finished = false;
      let timer = null;

      const cleanup = () => {
        if (timer != null) {
          clearTimeout(timer);
          timer = null;
        }
      };

      const fail = (err) => {
        if (finished) return;
        finished = true;
        cleanup();
        reject(err);
      };

      const done = () => {
        if (finished) return;
        finished = true;
        cleanup();
        resolve();
      };

      if (signal) {
        if (signal.aborted) {
          fail(new DOMException('Aborted', 'AbortError'));
          return;
        }
        signal.addEventListener('abort', () => {
          fail(new DOMException('Aborted', 'AbortError'));
        }, { once: true });
      }

      // Hard stop so we never hang longer than duration + grace
      const hardStop = setTimeout(() => done(), Math.ceil(durationSec * 1000) + 1500);

      const step = () => {
        if (finished) return;
        if (signal && signal.aborted) {
          clearTimeout(hardStop);
          fail(new DOMException('Aborted', 'AbortError'));
          return;
        }
        const elapsed = (performance.now() - t0) / 1000;
        const progress = Math.min(1, elapsed / durationSec);
        try {
          onTick(elapsed, progress);
        } catch (e) {
          clearTimeout(hardStop);
          fail(e);
          return;
        }
        if (elapsed >= durationSec) {
          clearTimeout(hardStop);
          done();
          return;
        }
        // ~15fps is enough for text slides and keeps CPU lower on phones
        timer = setTimeout(step, 66);
      };

      step();
    });
  }

  /**
   * @param {object} opts
   * @returns {Promise<{ blob: Blob, mimeType: string, filename: string, duration: number, hadVoice: boolean }>}
   */
  async function createScriptureVideo(opts) {
    const {
      reference,
      translation,
      verses,
      audioArrayBuffer,
      siteUrl = 'thewordincontext.org',
      onProgress,
      signal
    } = opts || {};

    if (signal && signal.aborted) throw new DOMException('Aborted', 'AbortError');

    if (typeof MediaRecorder === 'undefined' || typeof HTMLCanvasElement === 'undefined') {
      throw new Error('Video recording is not supported in this browser. Share as text instead.');
    }

    const preferredMime = pickRecorderMime();

    const canvas = document.createElement('canvas');
    canvas.width = W;
    canvas.height = H;
    // Keep canvas in the DOM (off-screen). Safari often produces no frames / hangs
    // MediaRecorder if the canvas is fully detached.
    canvas.setAttribute('aria-hidden', 'true');
    canvas.style.cssText = 'position:fixed;left:-9999px;top:0;width:1px;height:1px;opacity:0;pointer-events:none;';
    document.body.appendChild(canvas);

    const ctx = canvas.getContext('2d', { alpha: false, desynchronized: true });
    if (!ctx) {
      canvas.remove();
      throw new Error('Canvas unavailable');
    }

    ctx.font = 'italic 400 40px Georgia, "Times New Roman", serif';
    const pages = splitIntoPages(ctx, verses || [], W - 240, 18);
    const verseText = (verses || []).map((v) => v.text).join(' ');

    let audioPack = null;
    let duration = safeDuration(estimateDurationSec(verseText), verseText);
    let hadVoice = false;

    if (audioArrayBuffer && audioArrayBuffer.byteLength > 0) {
      onProgress && onProgress(0.12, 'Preparing voice…');
      audioPack = await decodeAudio(audioArrayBuffer);
      if (audioPack && audioPack.buffer) {
        duration = safeDuration(audioPack.buffer.duration + 0.4, verseText);
        hadVoice = true;
      }
    }

    onProgress && onProgress(0.2, 'Recording video…');

    const drawAt = (progress) => {
      const pageIndex = pages.length <= 1
        ? 0
        : Math.min(pages.length - 1, Math.floor(progress * pages.length));
      drawFrame(ctx, {
        reference,
        translation,
        pages,
        pageIndex,
        progress,
        siteUrl
      });
    };

    // Prime several frames before captureStream (helps WebKit)
    drawAt(0);
    await wait(40);
    drawAt(0);

    let stream;
    try {
      stream = canvas.captureStream(15);
    } catch (e) {
      canvas.remove();
      throw new Error('This browser cannot capture video from the canvas. Share as text instead.');
    }

    let audioCtx = null;
    let bufferSource = null;
    let audioEnded = false;

    if (audioPack) {
      audioCtx = audioPack.ctx;
      if (audioCtx.state === 'suspended') {
        try { await audioCtx.resume(); } catch (e) {}
      }
      try {
        const dest = audioCtx.createMediaStreamDestination();
        bufferSource = audioCtx.createBufferSource();
        bufferSource.buffer = audioPack.buffer;
        bufferSource.onended = () => { audioEnded = true; };
        bufferSource.connect(dest);
        try {
          const gain = audioCtx.createGain();
          gain.gain.value = 0.9;
          bufferSource.connect(gain);
          gain.connect(audioCtx.destination);
        } catch (e) {}
        dest.stream.getAudioTracks().forEach((track) => {
          try { stream.addTrack(track); } catch (e) {}
        });
      } catch (e) {
        // Continue silent if audio graph fails
        hadVoice = false;
        bufferSource = null;
      }
    }

    const recorder = createRecorder(stream, preferredMime);
    const actualMime = recorder.mimeType || preferredMime || 'video/webm';
    const chunks = [];
    recorder.ondataavailable = (e) => {
      if (e.data && e.data.size > 0) chunks.push(e.data);
    };

    let stopResolved = false;
    const stopped = new Promise((resolve) => {
      recorder.onstop = () => {
        stopResolved = true;
        resolve();
      };
      recorder.onerror = () => {
        stopResolved = true;
        resolve(); // don't hang; empty blob handled later
      };
    });

    const hardCleanup = () => {
      try {
        if (recorder.state === 'recording' || recorder.state === 'paused') {
          try { recorder.requestData(); } catch (e) {}
          try { recorder.stop(); } catch (e) {}
        }
      } catch (e) {}
      try {
        if (bufferSource) bufferSource.stop();
      } catch (e) {}
      try {
        stream.getTracks().forEach((t) => t.stop());
      } catch (e) {}
      try { canvas.remove(); } catch (e) {}
      if (audioCtx) {
        try { audioCtx.close(); } catch (e) {}
      }
    };

    if (signal) {
      signal.addEventListener('abort', () => {
        hardCleanup();
      }, { once: true });
    }

    try {
      // timeslice so we always get chunks even if stop is flaky
      try {
        recorder.start(250);
      } catch (e) {
        // Some browsers reject timeslice
        recorder.start();
      }
    } catch (e) {
      hardCleanup();
      throw new Error('Could not start video recording on this device. Share as text instead.');
    }

    if (bufferSource) {
      try { bufferSource.start(0); } catch (e) {}
    }

    // Keep drawing while recording (wall clock — never stuck if rAF sleeps)
    try {
      await runTimedLoop({
        durationSec: duration,
        signal,
        onTick: (elapsed, progress) => {
          drawAt(progress);
          const label = hadVoice && !audioEnded && progress < 0.98
            ? 'Recording video…'
            : 'Finishing video…';
          onProgress && onProgress(0.2 + progress * 0.75, label);
        }
      });
    } catch (e) {
      hardCleanup();
      throw e;
    }

    onProgress && onProgress(0.96, 'Finishing video…');

    try {
      if (recorder.state === 'recording') {
        try { recorder.requestData(); } catch (e) {}
        recorder.stop();
      }
    } catch (e) {}

    // Never wait forever for onstop
    await Promise.race([
      stopped,
      wait(3000).then(() => {
        if (!stopResolved) {
          try { if (recorder.state !== 'inactive') recorder.stop(); } catch (e) {}
        }
      })
    ]);
    // Extra beat for last dataavailable
    await wait(120);

    try {
      stream.getTracks().forEach((t) => t.stop());
    } catch (e) {}
    try {
      if (bufferSource) bufferSource.stop();
    } catch (e) {}
    if (audioCtx) {
      try { await audioCtx.close(); } catch (e) {}
    }
    try { canvas.remove(); } catch (e) {}

    const blob = new Blob(chunks, { type: actualMime });
    if (!blob.size) {
      throw new Error('Video came out empty. Try a shorter selection, Safari, or share as text.');
    }

    const ext = /mp4/i.test(actualMime) ? 'mp4' : 'webm';
    const safeRef = String(reference || 'scripture')
      .replace(/[^\w\s\-–—]/g, '')
      .trim()
      .replace(/\s+/g, '-')
      .slice(0, 48) || 'scripture';

    onProgress && onProgress(1, 'Done');

    return {
      blob,
      mimeType: actualMime,
      filename: `${safeRef}.${ext}`,
      duration,
      hadVoice
    };
  }

  async function fetchShareTts(text, signal) {
    const headers = { 'Content-Type': 'application/json' };
    try {
      const token = localStorage.getItem('auth_token');
      if (token) headers.Authorization = 'Bearer ' + token;
    } catch (e) {}
    const res = await fetch('/api/share-tts', {
      method: 'POST',
      headers,
      body: JSON.stringify({ text }),
      signal
    });
    if (!res.ok) {
      let msg = `Voice service unavailable (${res.status})`;
      try {
        const data = await res.json();
        if (data && data.error) msg = data.error;
      } catch (e) {}
      const err = new Error(msg);
      err.status = res.status;
      throw err;
    }
    return res.arrayBuffer();
  }

  function buildNarrationText(reference, translation, verses) {
    const ref = String(reference || '').trim();
    const trans = String(translation || '').trim();
    const parts = [];
    if (ref) parts.push(ref + (trans ? `, ${trans}` : '') + '.');
    (verses || []).forEach((v) => {
      const t = String(v.text || '').trim();
      if (t) parts.push(t);
    });
    return parts.join(' ').replace(/\s+/g, ' ').trim();
  }

  global.ShareVideo = {
    pickRecorderMime,
    createScriptureVideo,
    fetchShareTts,
    buildNarrationText,
    estimateDurationSec
  };
})(typeof window !== 'undefined' ? window : globalThis);
