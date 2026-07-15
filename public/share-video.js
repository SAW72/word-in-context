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
    // Prefer MP4 everywhere (Facebook Reels / YouTube Shorts / iMessage).
    // Chrome desktop often only supports webm — we convert to MP4 after if needed.
    const candidates = [
      'video/mp4',
      'video/mp4;codecs=avc1.42E01E,mp4a.40.2',
      'video/mp4;codecs=avc1.4d002a,mp4a.40.2',
      'video/webm;codecs=vp9,opus',
      'video/webm;codecs=vp8,opus',
      'video/webm'
    ];
    for (const t of candidates) {
      try {
        if (MediaRecorder.isTypeSupported(t)) return t;
      } catch (e) { /* ignore */ }
    }
    return '';
  }

  function isMp4Blob(blob, filename) {
    return !!(blob && (/mp4/i.test(blob.type || '') || /\.mp4$/i.test(filename || '')));
  }

  /**
   * Convert WebM (or other) to MP4 for Facebook/YouTube using ffmpeg.wasm (loaded on demand).
   * First use downloads ~25MB converter once; then reuses if possible.
   */
  let _ffmpegPromise = null;
  async function getFfmpeg(onProgress) {
    if (_ffmpegPromise) return _ffmpegPromise;
    _ffmpegPromise = (async () => {
      onProgress && onProgress(0.05, 'Loading MP4 converter (one-time)…');
      const { FFmpeg } = await import('https://cdn.jsdelivr.net/npm/@ffmpeg/ffmpeg@0.12.10/+esm');
      const { toBlobURL } = await import('https://cdn.jsdelivr.net/npm/@ffmpeg/util@0.12.1/+esm');
      const ffmpeg = new FFmpeg();
      const baseURL = 'https://cdn.jsdelivr.net/npm/@ffmpeg/core@0.12.6/dist/esm';
      await ffmpeg.load({
        coreURL: await toBlobURL(`${baseURL}/ffmpeg-core.js`, 'text/javascript'),
        wasmURL: await toBlobURL(`${baseURL}/ffmpeg-core.wasm`, 'application/wasm')
      });
      return ffmpeg;
    })().catch((err) => {
      _ffmpegPromise = null;
      throw err;
    });
    return _ffmpegPromise;
  }

  /**
   * Facebook Reels is stricter than YouTube:
   * - H.264 (NOT HEVC from Safari MediaRecorder)
   * - yuv420p, even dimensions
   * - AAC audio track (silent videos with no audio are often rejected)
   * - baseline/main profile, +faststart
   */
  async function convertToMp4(inputBlob, onProgress) {
    const { fetchFile } = await import('https://cdn.jsdelivr.net/npm/@ffmpeg/util@0.12.1/+esm');
    const ffmpeg = await getFfmpeg(onProgress);
    onProgress && onProgress(0.2, 'Encoding Facebook-ready MP4…');
    const onProg = ({ progress }) => {
      const p = typeof progress === 'number' ? progress : 0;
      onProgress && onProgress(0.2 + Math.max(0, Math.min(1, p)) * 0.75, 'Encoding Facebook-ready MP4…');
    };
    ffmpeg.on('progress', onProg);

    const inName = /webm/i.test(inputBlob.type || '')
      ? 'in.webm'
      : (/mp4/i.test(inputBlob.type || '') ? 'in.mp4' : 'in.input');
    await ffmpeg.writeFile(inName, await fetchFile(inputBlob));

    // Scale to 720x1280 (9:16), force H.264 baseline + AAC. Min ~3.5s for Reels.
    const vf = 'scale=720:1280:force_original_aspect_ratio=decrease,pad=720:1280:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=30,format=yuv420p,tpad=stop_mode=clone:stop_duration=0.5';

    const commonVideo = [
      '-vf', vf,
      '-c:v', 'libx264',
      '-profile:v', 'baseline',
      '-level', '3.1',
      '-pix_fmt', 'yuv420p',
      '-r', '30',
      '-g', '60',
      '-preset', 'veryfast',
      '-crf', '23',
      '-movflags', '+faststart',
      '-t', '90'
    ];

    let encoded = false;
    // Pass 1: keep source audio if present
    try {
      await ffmpeg.exec([
        '-i', inName,
        ...commonVideo,
        '-c:a', 'aac',
        '-b:a', '128k',
        '-ar', '44100',
        '-ac', '2',
        'out.mp4'
      ]);
      encoded = true;
    } catch (e1) {
      console.warn('[ShareVideo] encode with source audio failed, trying silent AAC', e1);
    }

    // Pass 2: no/bad audio → add silent stereo AAC (Facebook often requires an audio track)
    if (!encoded) {
      try {
        await ffmpeg.exec([
          '-i', inName,
          '-f', 'lavfi',
          '-i', 'anullsrc=channel_layout=stereo:sample_rate=44100',
          ...commonVideo,
          '-c:a', 'aac',
          '-b:a', '128k',
          '-ar', '44100',
          '-ac', '2',
          '-map', '0:v:0',
          '-map', '1:a:0',
          '-shortest',
          'out.mp4'
        ]);
        encoded = true;
      } catch (e2) {
        console.warn('[ShareVideo] silent-audio encode failed', e2);
        // Pass 3: video only (last resort — YouTube may still take it)
        await ffmpeg.exec([
          '-i', inName,
          ...commonVideo,
          '-an',
          'out.mp4'
        ]);
        encoded = true;
      }
    }

    const data = await ffmpeg.readFile('out.mp4');
    try { await ffmpeg.deleteFile(inName); } catch (e) {}
    try { await ffmpeg.deleteFile('out.mp4'); } catch (e) {}
    try { ffmpeg.off('progress', onProg); } catch (e) {}
    const bytes = data.buffer ? new Uint8Array(data.buffer) : new Uint8Array(data);
    if (!bytes.length) throw new Error('Empty MP4 output');
    return new Blob([bytes], { type: 'video/mp4' });
  }

  /**
   * Always re-encode for social upload. Safari "mp4" is often HEVC — YouTube accepts it,
   * Facebook Reels frequently rejects it with "file can't be uploaded".
   */
  async function ensureMp4(blob, filename, onProgress, opts) {
    const base = String(filename || 'scripture').replace(/\.\w+$/, '');
    // Images pass through
    if (blob && /image\//i.test(blob.type || '')) {
      return { blob, mimeType: blob.type, filename: filename || `${base}.png`, converted: false };
    }
    // forceReencode default true for Facebook compatibility
    const force = !opts || opts.forceReencode !== false;
    if (!force && isMp4Blob(blob, filename)) {
      return {
        blob,
        mimeType: 'video/mp4',
        filename: `${base}.mp4`,
        converted: false
      };
    }
    try {
      const mp4 = await convertToMp4(blob, onProgress);
      if (!mp4 || !mp4.size) throw new Error('Empty MP4');
      // Facebook soft limit ~100MB for short reels; warn only
      if (mp4.size > 95 * 1024 * 1024) {
        console.warn('[ShareVideo] MP4 is large for Facebook:', mp4.size);
      }
      onProgress && onProgress(1, 'Facebook-ready MP4');
      return {
        blob: mp4,
        mimeType: 'video/mp4',
        filename: 'word-in-context-reel.mp4',
        converted: true,
        facebookReady: true
      };
    } catch (e) {
      console.warn('[ShareVideo] MP4 convert failed', e);
      return {
        blob,
        mimeType: blob.type || 'video/webm',
        filename: filename || `${base}.webm`,
        converted: false,
        convertFailed: true,
        convertError: e && e.message,
        facebookReady: false
      };
    }
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
    // Solid dark base so verse text always has contrast
    const g = ctx.createLinearGradient(0, 0, 0, H);
    g.addColorStop(0, '#14110e');
    g.addColorStop(0.55, '#1e1914');
    g.addColorStop(1, '#0f0d0b');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, H);

    // Banner only as a thin top strip (never covers the verse text)
    const bannerH = 120;
    if (brand && brand.banner) {
      drawCoverImage(ctx, brand.banner, 0, 0, W, bannerH, 0.75);
      ctx.fillStyle = 'rgba(12, 10, 8, 0.55)';
      ctx.fillRect(0, 0, W, bannerH);
      // Soft fade into body
      const fade = ctx.createLinearGradient(0, bannerH - 8, 0, bannerH + 40);
      fade.addColorStop(0, 'rgba(20,17,14,0)');
      fade.addColorStop(1, 'rgba(20,17,14,1)');
      ctx.fillStyle = fade;
      ctx.fillRect(0, bannerH - 8, W, 50);
    }

    // Large readable text panel (center of video)
    const panelX = 36;
    const panelY = 150;
    const panelW = W - 72;
    const panelH = H - 280;
    ctx.fillStyle = 'rgba(255, 253, 248, 0.96)';
    roundRect(ctx, panelX, panelY, panelW, panelH, 18);
    ctx.fill();
    ctx.strokeStyle = 'rgba(201, 162, 39, 0.65)';
    ctx.lineWidth = 2;
    ctx.stroke();

    // Gold frame around full video
    ctx.strokeStyle = 'rgba(201, 162, 39, 0.45)';
    ctx.lineWidth = 3;
    ctx.strokeRect(16, 16, W - 32, H - 32);

    // Small logo top-left of panel
    if (brand && brand.logo) {
      const s = 40;
      try {
        ctx.drawImage(brand.logo, panelX + 16, panelY + 14, s, s);
      } catch (e) {}
    }
  }

  function roundRect(ctx, x, y, w, h, r) {
    const rad = Math.min(r, w / 2, h / 2);
    ctx.beginPath();
    ctx.moveTo(x + rad, y);
    ctx.arcTo(x + w, y, x + w, y + h, rad);
    ctx.arcTo(x + w, y + h, x, y + h, rad);
    ctx.arcTo(x, y + h, x, y, rad);
    ctx.arcTo(x, y, x + w, y, rad);
    ctx.closePath();
  }

  /**
   * Always draws verse text on every frame — high contrast on white panel.
   * pages: from splitIntoPages; rawVerses used as fallback if pages empty.
   */
  function drawFrame(ctx, opts) {
    const {
      reference,
      translation,
      pages,
      pageIndex,
      progress,
      siteUrl,
      brand,
      rawVerses
    } = opts;

    drawBrandedBackground(ctx, brand);

    // Brand label on banner strip
    ctx.textAlign = 'center';
    ctx.fillStyle = '#e0c060';
    ctx.font = '700 17px system-ui, -apple-system, sans-serif';
    ctx.fillText('THE WORD IN CONTEXT', W / 2, 48);
    ctx.fillStyle = 'rgba(245, 239, 227, 0.85)';
    ctx.font = '500 13px system-ui, -apple-system, sans-serif';
    ctx.fillText(siteUrl || 'thewordincontext.org', W / 2, 72);

    // Inside white panel: reference + verse text (this is what must appear in the video)
    const panelX = 36;
    const panelY = 150;
    const panelW = W - 72;
    const textLeft = panelX + 28;
    const textWidth = panelW - 56;
    let y = panelY + 70;

    // Reference (e.g. Psalm 32:1–11)
    ctx.textAlign = 'center';
    ctx.fillStyle = '#1a1814';
    ctx.font = '700 30px Georgia, "Times New Roman", serif';
    const refLines = wrapLines(ctx, reference || 'Scripture', textWidth);
    refLines.forEach((ln) => {
      ctx.fillText(ln, W / 2, y);
      y += 36;
    });

    if (translation) {
      ctx.fillStyle = '#8b7355';
      ctx.font = '600 16px system-ui, -apple-system, sans-serif';
      ctx.fillText(String(translation), W / 2, y + 2);
      y += 28;
    }

    // Divider
    ctx.strokeStyle = 'rgba(201, 162, 39, 0.55)';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(W * 0.28, y + 8);
    ctx.lineTo(W * 0.72, y + 8);
    ctx.stroke();
    y += 36;

    // Verse body — MUST always paint something
    ctx.textAlign = 'left';
    ctx.fillStyle = '#1a1814';
    const maxTextBottom = panelY + (H - 280) - 36;

    let painted = false;
    const page = (pages && pages.length)
      ? (pages[Math.min(Math.max(0, pageIndex), pages.length - 1)] || [])
      : [];

    if (page.length) {
      page.forEach((block) => {
        ctx.font = '500 24px Georgia, "Times New Roman", serif';
        (block.lines || []).forEach((ln) => {
          if (y > maxTextBottom) return;
          ctx.fillText(ln, textLeft, y);
          y += 34;
          painted = true;
        });
        y += 12;
      });
    }

    // Fallback: draw raw verse text if pagination produced nothing
    if (!painted && rawVerses && rawVerses.length) {
      ctx.font = '500 24px Georgia, "Times New Roman", serif';
      rawVerses.forEach((v) => {
        const lines = wrapLines(ctx, `${v.number}  ${v.text}`, textWidth);
        lines.forEach((ln) => {
          if (y > maxTextBottom) return;
          ctx.fillText(ln, textLeft, y);
          y += 34;
          painted = true;
        });
        y += 12;
      });
    }

    if (!painted) {
      ctx.font = '500 22px Georgia, serif';
      ctx.fillStyle = '#5c574d';
      ctx.fillText('Scripture text unavailable for this selection.', textLeft, y);
    }

    // Footer below panel
    const p = Number.isFinite(progress) ? Math.max(0, Math.min(1, progress)) : 0;
    const barY = H - 88;
    const barX = 80;
    const barW = W - 160;
    ctx.fillStyle = 'rgba(255,255,255,0.12)';
    ctx.fillRect(barX, barY, barW, 5);
    ctx.fillStyle = '#c9a227';
    ctx.fillRect(barX, barY, p * barW, 5);

    ctx.textAlign = 'center';
    ctx.fillStyle = 'rgba(240, 235, 227, 0.8)';
    ctx.font = '500 14px system-ui, -apple-system, sans-serif';
    ctx.fillText('Read free · ' + (siteUrl || 'thewordincontext.org'), W / 2, H - 48);

    if (pages && pages.length > 1) {
      ctx.fillStyle = 'rgba(201, 162, 39, 0.9)';
      ctx.font = '600 13px system-ui, -apple-system, sans-serif';
      ctx.fillText(`Text ${pageIndex + 1} / ${pages.length}`, W / 2, H - 68);
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
    const verses = opts.verses || [];
    ctx.font = '500 24px Georgia, serif';
    const pages = splitIntoPages(ctx, verses, W - 72 - 56, 18);
    drawFrame(ctx, {
      reference: opts.reference,
      translation: opts.translation,
      pages,
      pageIndex: 0,
      progress: 1,
      siteUrl: opts.siteUrl || 'thewordincontext.org',
      brand,
      rawVerses: verses
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

    const verseList = verses || [];
    ctx.font = '500 24px Georgia, serif';
    // Slightly fewer lines per page so text stays large and readable in video
    const pages = splitIntoPages(ctx, verseList, W - 72 - 56, 12);
    // Hold each text page long enough to read (~min 3s each) while still fitting audio length
    const pageHold = pages.length > 1
      ? Math.max(3, duration / pages.length)
      : duration;

    const drawAt = (progress) => {
      const elapsed = progress * duration;
      let pageIndex = 0;
      if (pages.length > 1) {
        pageIndex = Math.min(pages.length - 1, Math.floor(elapsed / pageHold));
      }
      drawFrame(ctx, {
        reference,
        translation,
        pages,
        pageIndex,
        progress,
        siteUrl,
        brand,
        rawVerses: verseList
      });
    };

    // Warm up frames with FULL text painted before capture starts
    drawAt(0);
    await wait(80);
    drawAt(0);
    await wait(80);
    drawAt(0);

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
    estimateDurationSec,
    ensureMp4,
    convertToMp4,
    isMp4Blob
  };
})(typeof window !== 'undefined' ? window : globalThis);
