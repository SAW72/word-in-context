/**
 * Scripture share media:
 *  - Vertical video: static branded background (banner/cross) + verse text + optional voice
 *  - Fallback: high-res PNG share card if video recording fails
 *
 * Cost: $0 for images/background (local canvas + your assets).
 * Paid only if narration uses /api/share-tts (xAI TTS).
 */
(function (global) {
  'use strict';

  // 9:16 social, but not too large (big canvases often yield audio-only / black video on Safari)
  const W = 720;
  const H = 1280;
  const MAX_DURATION_SEC = 90;
  const BRAND_IMAGES = [
    '/icons/whop-banner-2000x1000.png',
    '/icons/share-og.png',
    '/icons/icon-512.png'
  ];

  let brandCache = null; // { banner, logo } HTMLImageElement | null

  function pickRecorderMime() {
    if (typeof MediaRecorder === 'undefined') return '';
    const ua = navigator.userAgent || '';
    const isApple = /iPad|iPhone|iPod|Macintosh/i.test(ua) && !/Chrome|CriOS|Firefox|FxiOS|Android/i.test(ua);
    // Safari/iOS: mp4 first. Chrome: webm first.
    const candidates = isApple
      ? ['video/mp4', 'video/webm;codecs=vp8,opus', 'video/webm']
      : ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm', 'video/mp4'];
    for (const t of candidates) {
      try {
        if (MediaRecorder.isTypeSupported(t)) return t;
      } catch (e) { /* ignore */ }
    }
    return '';
  }

  function loadImage(src) {
    return new Promise((resolve) => {
      const img = new Image();
      img.crossOrigin = 'anonymous';
      img.onload = () => resolve(img);
      img.onerror = () => resolve(null);
      img.src = src;
    });
  }

  async function loadBrandImages() {
    if (brandCache) return brandCache;
    const loaded = await Promise.all(BRAND_IMAGES.map(loadImage));
    brandCache = {
      banner: loaded[0] || loaded[1] || null,
      card: loaded[1] || null,
      logo: loaded[2] || null
    };
    return brandCache;
  }

  function wrapLines(ctx, text, maxWidth) {
    const words = String(text || '').split(/\s+/).filter(Boolean);
    const lines = [];
    let line = '';
    for (const word of words) {
      const test = line ? `${line} ${word}` : word;
      if (ctx.measureText(test).width <= maxWidth) line = test;
      else {
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

  function drawCoverImage(ctx, img, dx, dy, dw, dh, alpha) {
    if (!img || !img.width) return;
    ctx.save();
    ctx.globalAlpha = alpha == null ? 1 : alpha;
    // object-fit: cover
    const ir = img.width / img.height;
    const br = dw / dh;
    let sx = 0;
    let sy = 0;
    let sw = img.width;
    let sh = img.height;
    if (ir > br) {
      sw = img.height * br;
      sx = (img.width - sw) / 2;
    } else {
      sh = img.width / br;
      sy = (img.height - sh) / 2;
    }
    ctx.drawImage(img, sx, sy, sw, sh, dx, dy, dw, dh);
    ctx.restore();
  }

  function drawBrandedBackground(ctx, brand) {
    // Base parchment / dark brand gradient
    const g = ctx.createLinearGradient(0, 0, 0, H);
    g.addColorStop(0, '#1a1510');
    g.addColorStop(0.5, '#2a2118');
    g.addColorStop(1, '#12100e');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, H);

    // Banner across top (Word in Context / cross artwork)
    if (brand && brand.banner) {
      drawCoverImage(ctx, brand.banner, 0, 0, W, Math.round(H * 0.28), 0.55);
      // Darken so text stays readable
      const fade = ctx.createLinearGradient(0, 0, 0, Math.round(H * 0.32));
      fade.addColorStop(0, 'rgba(18,16,14,0.35)');
      fade.addColorStop(1, 'rgba(18,16,14,0.92)');
      ctx.fillStyle = fade;
      ctx.fillRect(0, 0, W, Math.round(H * 0.32));
    }

    // Soft gold glow behind text area
    const radial = ctx.createRadialGradient(W * 0.5, H * 0.42, 20, W * 0.5, H * 0.45, W * 0.55);
    radial.addColorStop(0, 'rgba(201, 162, 39, 0.16)');
    radial.addColorStop(1, 'rgba(201, 162, 39, 0)');
    ctx.fillStyle = radial;
    ctx.fillRect(0, 0, W, H);

    // Frame
    ctx.strokeStyle = 'rgba(201, 162, 39, 0.5)';
    ctx.lineWidth = 3;
    ctx.strokeRect(28, 28, W - 56, H - 56);

    // Logo badge
    if (brand && brand.logo) {
      const s = 64;
      ctx.save();
      ctx.beginPath();
      ctx.arc(W / 2, 78, s / 2 + 4, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(255,253,248,0.12)';
      ctx.fill();
      ctx.drawImage(brand.logo, W / 2 - s / 2, 78 - s / 2, s, s);
      ctx.restore();
    }
  }

  function drawFrame(ctx, opts) {
    const {
      reference,
      translation,
      pages,
      pageIndex,
      progress,
      siteUrl,
      brand
    } = opts;

    drawBrandedBackground(ctx, brand);

    ctx.textAlign = 'center';
    ctx.fillStyle = '#c9a227';
    ctx.font = '700 18px system-ui, -apple-system, sans-serif';
    ctx.fillText('THE WORD IN CONTEXT', W / 2, brand && brand.logo ? 130 : 72);

    ctx.fillStyle = '#f5efe3';
    ctx.font = '600 36px Georgia, "Times New Roman", serif';
    const refLines = wrapLines(ctx, reference || 'Scripture', W - 100);
    let y = 180;
    refLines.forEach((ln) => {
      ctx.fillText(ln, W / 2, y);
      y += 42;
    });

    if (translation) {
      ctx.fillStyle = 'rgba(201, 162, 39, 0.95)';
      ctx.font = '500 18px system-ui, -apple-system, sans-serif';
      ctx.fillText(translation, W / 2, y + 4);
      y += 36;
    }

    ctx.strokeStyle = 'rgba(201, 162, 39, 0.4)';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(W * 0.28, y + 6);
    ctx.lineTo(W * 0.72, y + 6);
    ctx.stroke();
    y += 40;

    const page = pages[Math.min(pageIndex, Math.max(0, pages.length - 1))] || [];
    ctx.textAlign = 'left';
    ctx.fillStyle = '#f0ebe3';
    const left = 72;
    const maxTextBottom = H - 160;

    page.forEach((block) => {
      ctx.font = 'italic 400 26px Georgia, "Times New Roman", serif';
      block.lines.forEach((ln) => {
        if (y > maxTextBottom) return;
        ctx.fillText(ln, left, y);
        y += 36;
      });
      y += 16;
    });

    // Progress
    const barY = H - 120;
    const barX = 80;
    const barW = W - 160;
    ctx.fillStyle = 'rgba(255,255,255,0.12)';
    ctx.fillRect(barX, barY, barW, 6);
    ctx.fillStyle = '#c9a227';
    const p = Number.isFinite(progress) ? Math.max(0, Math.min(1, progress)) : 0;
    ctx.fillRect(barX, barY, p * barW, 6);

    ctx.textAlign = 'center';
    ctx.fillStyle = 'rgba(240, 235, 227, 0.75)';
    ctx.font = '500 16px system-ui, -apple-system, sans-serif';
    ctx.fillText(siteUrl || 'thewordincontext.org', W / 2, H - 72);
    ctx.fillStyle = 'rgba(201, 162, 39, 0.85)';
    ctx.font = '400 13px system-ui, -apple-system, sans-serif';
    ctx.fillText('Read free · Study with AI', W / 2, H - 48);

    if (pages.length > 1) {
      ctx.fillStyle = 'rgba(201, 162, 39, 0.7)';
      ctx.font = '500 14px system-ui, -apple-system, sans-serif';
      ctx.fillText(`${pageIndex + 1} / ${pages.length}`, W / 2, H - 96);
    }
  }

  async function decodeAudio(arrayBuffer) {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return null;
    const ctx = new Ctx();
    try {
      const buffer = await ctx.decodeAudioData(arrayBuffer.slice(0));
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
    return Math.max(5, Math.min(MAX_DURATION_SEC, (words / 140) * 60 + 1.8));
  }

  function safeDuration(seconds, fallbackText) {
    let d = Number(seconds);
    if (!Number.isFinite(d) || d <= 0) d = estimateDurationSec(fallbackText);
    return Math.max(4, Math.min(MAX_DURATION_SEC, d));
  }

  function wait(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function createRecorder(stream, mimeType) {
    const attempts = [];
    if (mimeType) attempts.push({ mimeType, videoBitsPerSecond: 2_000_000 });
    attempts.push({ videoBitsPerSecond: 2_000_000 });
    attempts.push({});
    let lastErr = null;
    for (const opts of attempts) {
      try {
        return new MediaRecorder(stream, opts);
      } catch (e) {
        lastErr = e;
      }
    }
    throw lastErr || new Error('MediaRecorder unavailable');
  }

  function mountCanvas() {
    const canvas = document.createElement('canvas');
    canvas.width = W;
    canvas.height = H;
    canvas.setAttribute('aria-hidden', 'true');
    // Visible 1×1 can still help some engines; keep off-screen
    canvas.style.cssText = 'position:fixed;left:0;top:0;width:2px;height:2px;opacity:0.01;pointer-events:none;z-index:-1;';
    document.body.appendChild(canvas);
    return canvas;
  }

  /**
   * Build a static PNG share card (always works; free).
   */
  async function createShareCardPng(opts) {
    const brand = await loadBrandImages();
    const canvas = document.createElement('canvas');
    canvas.width = W;
    canvas.height = H;
    const ctx = canvas.getContext('2d', { alpha: false });
    ctx.font = 'italic 400 26px Georgia, serif';
    const pages = splitIntoPages(ctx, opts.verses || [], W - 144, 16);
    // For still image, put as much as fits on page 0 (or multi-page not needed)
    drawFrame(ctx, {
      reference: opts.reference,
      translation: opts.translation,
      pages,
      pageIndex: 0,
      progress: 1,
      siteUrl: opts.siteUrl || 'thewordincontext.org',
      brand
    });
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
    if (!blob) throw new Error('Could not create share image');
    const safeRef = String(opts.reference || 'scripture')
      .replace(/[^\w\s\-–—]/g, '')
      .trim()
      .replace(/\s+/g, '-')
      .slice(0, 40) || 'scripture';
    return {
      blob,
      mimeType: 'image/png',
      filename: `${safeRef}.png`,
      kind: 'image'
    };
  }

  /**
   * Record vertical video: static branded slide(s) + optional voice.
   * Uses continuous rAF drawing so video track has real frames (not audio-only).
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

    const brand = await loadBrandImages();
    onProgress && onProgress(0.08, 'Preparing artwork…');

    const verseText = (verses || []).map((v) => v.text).join(' ');
    let duration = safeDuration(estimateDurationSec(verseText), verseText);
    let hadVoice = false;
    let audioPack = null;

    if (audioArrayBuffer && audioArrayBuffer.byteLength > 0) {
      onProgress && onProgress(0.12, 'Preparing voice…');
      audioPack = await decodeAudio(audioArrayBuffer);
      if (audioPack) {
        duration = safeDuration(audioPack.buffer.duration + 0.5, verseText);
        hadVoice = true;
      }
    }

    // Always have a still card ready as fallback
    let cardFallback = null;
    try {
      cardFallback = await createShareCardPng({ reference, translation, verses, siteUrl });
    } catch (e) { /* optional */ }

    if (typeof MediaRecorder === 'undefined' || !HTMLCanvasElement.prototype.captureStream) {
      if (cardFallback) {
        onProgress && onProgress(1, 'Image ready (video not supported here)');
        return { ...cardFallback, duration: 0, hadVoice: false, videoFailed: true };
      }
      throw new Error('Video not supported on this device. Share as text instead.');
    }

    const canvas = mountCanvas();
    const ctx = canvas.getContext('2d', { alpha: false });
    if (!ctx) {
      canvas.remove();
      throw new Error('Canvas unavailable');
    }

    ctx.font = 'italic 400 26px Georgia, serif';
    const pages = splitIntoPages(ctx, verses || [], W - 144, 14);

    const drawAt = (progress) => {
      const pageIndex = pages.length <= 1
        ? 0
        : Math.min(pages.length - 1, Math.floor(Math.max(0, Math.min(0.999, progress)) * pages.length));
      drawFrame(ctx, {
        reference,
        translation,
        pages,
        pageIndex,
        progress,
        siteUrl,
        brand
      });
    };

    // Warm up frames before capture
    drawAt(0);
    await wait(50);
    drawAt(0);
    await wait(50);

    let stream;
    try {
      // 0 = manual frames when requestFrame exists; still pass fps for others
      stream = canvas.captureStream(30);
    } catch (e) {
      canvas.remove();
      if (cardFallback) return { ...cardFallback, duration: 0, hadVoice: false, videoFailed: true };
      throw new Error('Could not capture video frames');
    }

    // Ensure we have a video track
    const vTracks = stream.getVideoTracks();
    if (!vTracks.length) {
      canvas.remove();
      if (cardFallback) return { ...cardFallback, duration: 0, hadVoice: false, videoFailed: true };
      throw new Error('No video track — device produced audio only');
    }

    let audioCtx = null;
    let bufferSource = null;
    if (audioPack) {
      audioCtx = audioPack.ctx;
      try {
        if (audioCtx.state === 'suspended') await audioCtx.resume();
        const dest = audioCtx.createMediaStreamDestination();
        bufferSource = audioCtx.createBufferSource();
        bufferSource.buffer = audioPack.buffer;
        bufferSource.connect(dest);
        // Hear while recording
        try {
          const g = audioCtx.createGain();
          g.gain.value = 0.9;
          bufferSource.connect(g);
          g.connect(audioCtx.destination);
        } catch (e) {}
        dest.stream.getAudioTracks().forEach((t) => {
          try { stream.addTrack(t); } catch (e) {}
        });
      } catch (e) {
        hadVoice = false;
        bufferSource = null;
      }
    }

    const preferredMime = pickRecorderMime();
    let recorder;
    try {
      recorder = createRecorder(stream, preferredMime);
    } catch (e) {
      hardStopTracks(stream);
      canvas.remove();
      if (cardFallback) return { ...cardFallback, duration: 0, hadVoice: false, videoFailed: true };
      throw new Error('Cannot record video on this browser');
    }

    const actualMime = recorder.mimeType || preferredMime || 'video/webm';
    const chunks = [];
    recorder.ondataavailable = (e) => {
      if (e.data && e.data.size > 0) chunks.push(e.data);
    };

    let stopDone = false;
    const stopped = new Promise((resolve) => {
      recorder.onstop = () => { stopDone = true; resolve(); };
      recorder.onerror = () => { stopDone = true; resolve(); };
    });

    let animId = 0;
    let running = true;
    const t0 = performance.now();

    const paintLoop = () => {
      if (!running) return;
      const elapsed = (performance.now() - t0) / 1000;
      const progress = Math.min(1, elapsed / duration);
      drawAt(progress);
      // Push frame to captureStream when supported (critical for some WebKit builds)
      try {
        const track = stream.getVideoTracks()[0];
        if (track && typeof track.requestFrame === 'function') track.requestFrame();
      } catch (e) {}
      onProgress && onProgress(0.2 + progress * 0.7, 'Recording video…');
      animId = requestAnimationFrame(paintLoop);
    };

    const cleanup = async () => {
      running = false;
      try { cancelAnimationFrame(animId); } catch (e) {}
      try {
        if (bufferSource) bufferSource.stop(0);
      } catch (e) {}
      hardStopTracks(stream);
      try { canvas.remove(); } catch (e) {}
      if (audioCtx) {
        try { await audioCtx.close(); } catch (e) {}
      }
    };

    if (signal) {
      signal.addEventListener('abort', () => {
        running = false;
        try {
          if (recorder.state === 'recording') recorder.stop();
        } catch (e) {}
        cleanup();
      }, { once: true });
    }

    try {
      try { recorder.start(200); } catch (e) { recorder.start(); }
    } catch (e) {
      await cleanup();
      if (cardFallback) return { ...cardFallback, duration: 0, hadVoice: false, videoFailed: true };
      throw new Error('Could not start recording');
    }

    if (bufferSource) {
      try { bufferSource.start(0); } catch (e) {}
    }

    animId = requestAnimationFrame(paintLoop);

    // Wall-clock end (rAF alone can stall; we still stop on time)
    await new Promise((resolve, reject) => {
      const hard = setTimeout(() => resolve(), Math.ceil(duration * 1000) + 800);
      const tick = setInterval(() => {
        if (signal && signal.aborted) {
          clearInterval(tick);
          clearTimeout(hard);
          reject(new DOMException('Aborted', 'AbortError'));
          return;
        }
        const elapsed = (performance.now() - t0) / 1000;
        if (elapsed >= duration) {
          clearInterval(tick);
          clearTimeout(hard);
          resolve();
        }
      }, 100);
    }).catch(async (err) => {
      try { if (recorder.state === 'recording') recorder.stop(); } catch (e) {}
      await cleanup();
      throw err;
    });

    running = false;
    try { cancelAnimationFrame(animId); } catch (e) {}
    drawAt(1);
    onProgress && onProgress(0.95, 'Finishing video…');

    try {
      if (recorder.state === 'recording') {
        try { recorder.requestData(); } catch (e) {}
        recorder.stop();
      }
    } catch (e) {}

    await Promise.race([stopped, wait(2500)]);
    await wait(150);
    await cleanup();

    const blob = new Blob(chunks, { type: actualMime });

    // Detect "audio-only" style failures: tiny blob or no video-ish size after long recording
    const minExpected = hadVoice ? 8000 : 4000;
    if (!blob.size || blob.size < minExpected) {
      if (cardFallback) {
        onProgress && onProgress(1, 'Video failed — share image ready');
        return { ...cardFallback, duration: 0, hadVoice: false, videoFailed: true, audioBlob: null };
      }
      throw new Error('Video came out empty. Try Share as text, or use the share image.');
    }

    const ext = /mp4/i.test(actualMime) ? 'mp4' : 'webm';
    const safeRef = String(reference || 'scripture')
      .replace(/[^\w\s\-–—]/g, '')
      .trim()
      .replace(/\s+/g, '-')
      .slice(0, 40) || 'scripture';

    onProgress && onProgress(1, 'Done');
    return {
      blob,
      mimeType: actualMime,
      filename: `${safeRef}.${ext}`,
      duration,
      hadVoice,
      kind: 'video',
      videoFailed: false
    };
  }

  function hardStopTracks(stream) {
    try {
      stream.getTracks().forEach((t) => {
        try { t.stop(); } catch (e) {}
      });
    } catch (e) {}
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
    createShareCardPng,
    fetchShareTts,
    buildNarrationText,
    estimateDurationSec
  };
})(typeof window !== 'undefined' ? window : globalThis);
