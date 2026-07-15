/**
 * Scripture voice-over video for social share.
 * Renders a vertical (9:16) canvas with verse text + optional narration audio, then
 * records via MediaRecorder for Messages / Facebook / download.
 */
(function (global) {
  'use strict';

  const W = 1080;
  const H = 1920;

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

    // soft gold glow
    const radial = ctx.createRadialGradient(W * 0.5, H * 0.28, 40, W * 0.5, H * 0.35, W * 0.7);
    radial.addColorStop(0, 'rgba(201, 162, 39, 0.18)');
    radial.addColorStop(1, 'rgba(201, 162, 39, 0)');
    ctx.fillStyle = radial;
    ctx.fillRect(0, 0, W, H);

    // thin gold frame
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

    // brand
    ctx.fillStyle = '#c9a227';
    ctx.font = '600 28px system-ui, -apple-system, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('THE WORD IN CONTEXT', W / 2, 130);

    // reference
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

    // divider
    ctx.strokeStyle = 'rgba(201, 162, 39, 0.35)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(W * 0.28, y + 10);
    ctx.lineTo(W * 0.72, y + 10);
    ctx.stroke();
    y += 70;

    // verse page
    const page = pages[Math.min(pageIndex, pages.length - 1)] || [];
    ctx.textAlign = 'left';
    ctx.fillStyle = '#f0ebe3';
    const left = 120;
    const maxW = W - 240;

    page.forEach((block) => {
      ctx.font = 'italic 400 40px Georgia, "Times New Roman", serif';
      block.lines.forEach((ln, i) => {
        if (y > H - 280) return;
        ctx.fillText(ln, left, y);
        y += 56;
      });
      y += 28;
    });

    // progress bar
    const barY = H - 200;
    const barX = 140;
    const barW = W - 280;
    ctx.fillStyle = 'rgba(255,255,255,0.12)';
    ctx.fillRect(barX, barY, barW, 8);
    ctx.fillStyle = '#c9a227';
    ctx.fillRect(barX, barY, Math.max(0, Math.min(1, progress)) * barW, 8);

    // footer
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
      return { ctx, buffer };
    } catch (e) {
      try { await ctx.close(); } catch (e2) {}
      return null;
    }
  }

  function estimateDurationSec(text) {
    const words = String(text || '').trim().split(/\s+/).filter(Boolean).length;
    // ~140 wpm narration + padding
    return Math.max(4, Math.min(180, (words / 140) * 60 + 1.5));
  }

  /**
   * @param {object} opts
   * @param {string} opts.reference
   * @param {string} opts.translation
   * @param {{number:number,text:string}[]} opts.verses
   * @param {ArrayBuffer|null} opts.audioArrayBuffer
   * @param {string} [opts.siteUrl]
   * @param {(pct:number,label:string)=>void} [opts.onProgress]
   * @param {AbortSignal} [opts.signal]
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

    const mimeType = pickRecorderMime();
    if (!mimeType || typeof MediaRecorder === 'undefined') {
      throw new Error('Video recording is not supported in this browser. Try Safari or Chrome on a recent iPhone, or use Share as text.');
    }

    const canvas = document.createElement('canvas');
    canvas.width = W;
    canvas.height = H;
    const ctx = canvas.getContext('2d', { alpha: false });
    if (!ctx) throw new Error('Canvas unavailable');

    // Measure pages with final font
    ctx.font = 'italic 400 40px Georgia, "Times New Roman", serif';
    const pages = splitIntoPages(ctx, verses || [], W - 240, 18);

    let audioPack = null;
    let duration = estimateDurationSec(
      (verses || []).map((v) => v.text).join(' ')
    );
    let hadVoice = false;

    if (audioArrayBuffer && audioArrayBuffer.byteLength > 0) {
      onProgress && onProgress(0.15, 'Preparing voice…');
      audioPack = await decodeAudio(audioArrayBuffer);
      if (audioPack && audioPack.buffer) {
        duration = Math.max(2, audioPack.buffer.duration + 0.35);
        hadVoice = true;
      }
    }

    onProgress && onProgress(0.25, 'Recording video…');

    // Prime a first frame (helps some Safari versions)
    drawFrame(ctx, {
      reference,
      translation,
      pages,
      pageIndex: 0,
      progress: 0,
      siteUrl
    });

    const fps = 30;
    const stream = canvas.captureStream(fps);
    let audioCtx = null;
    let bufferSource = null;

    if (audioPack) {
      audioCtx = audioPack.ctx;
      if (audioCtx.state === 'suspended') {
        try { await audioCtx.resume(); } catch (e) {}
      }
      const dest = audioCtx.createMediaStreamDestination();
      bufferSource = audioCtx.createBufferSource();
      bufferSource.buffer = audioPack.buffer;
      bufferSource.connect(dest);
      // Also play softly so user can hear generation (optional)
      try {
        const gain = audioCtx.createGain();
        gain.gain.value = 0.85;
        bufferSource.connect(gain);
        gain.connect(audioCtx.destination);
      } catch (e) {}
      dest.stream.getAudioTracks().forEach((track) => {
        try { stream.addTrack(track); } catch (e) {}
      });
    }

    const recorder = new MediaRecorder(stream, {
      mimeType,
      videoBitsPerSecond: 3_500_000
    });
    const chunks = [];
    recorder.ondataavailable = (e) => {
      if (e.data && e.data.size > 0) chunks.push(e.data);
    };

    const stopped = new Promise((resolve, reject) => {
      recorder.onstop = () => resolve();
      recorder.onerror = () => reject(new Error('Recording failed'));
    });

    if (signal) {
      signal.addEventListener('abort', () => {
        try { if (recorder.state !== 'inactive') recorder.stop(); } catch (e) {}
        try { if (bufferSource) bufferSource.stop(); } catch (e) {}
      }, { once: true });
    }

    recorder.start(100);
    const t0 = performance.now();
    if (bufferSource) {
      try { bufferSource.start(0); } catch (e) {}
    }

    await new Promise((resolve, reject) => {
      function tick() {
        if (signal && signal.aborted) {
          reject(new DOMException('Aborted', 'AbortError'));
          return;
        }
        const elapsed = (performance.now() - t0) / 1000;
        const progress = Math.min(1, elapsed / duration);
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

        onProgress && onProgress(0.25 + progress * 0.7, 'Recording video…');

        if (elapsed >= duration) {
          resolve();
          return;
        }
        requestAnimationFrame(tick);
      }
      requestAnimationFrame(tick);
    });

    try {
      if (recorder.state !== 'inactive') recorder.stop();
    } catch (e) {}
    try {
      if (bufferSource) bufferSource.stop();
    } catch (e) {}

    await stopped;

    // Stop tracks
    try {
      stream.getTracks().forEach((t) => t.stop());
    } catch (e) {}
    if (audioCtx) {
      try { await audioCtx.close(); } catch (e) {}
    }

    const blob = new Blob(chunks, { type: mimeType });
    if (!blob.size) throw new Error('Video came out empty — try a shorter selection or another browser.');

    const ext = mimeType.includes('mp4') ? 'mp4' : 'webm';
    const safeRef = String(reference || 'scripture')
      .replace(/[^\w\s\-–—]/g, '')
      .trim()
      .replace(/\s+/g, '-')
      .slice(0, 48) || 'scripture';

    onProgress && onProgress(1, 'Done');

    return {
      blob,
      mimeType,
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
