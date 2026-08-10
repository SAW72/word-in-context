/**
 * Talking-card reels for The Word in Context content → Buffer/TikTok.
 * Brand still + xAI TTS → 9:16 H.264 MP4 (public URL).
 * Port of IA contentVideoService (CommonJS).
 */
const { execFile } = require('child_process');
const { promisify } = require('util');
const fs = require('fs');
const path = require('path');
const Jimp = require('jimp');
const { updatePost, listPosts } = require('./queue');
const { PUBLIC_URL } = require('./brand');

const execFileAsync = promisify(execFile);

function resolveFfmpeg() {
  try {
    const p = require('ffmpeg-static');
    if (p && fs.existsSync(p)) return p;
  } catch {
    /* not installed */
  }
  return null;
}

let drawtextCached = null;
async function ffmpegHasDrawtext(ffmpeg) {
  if (drawtextCached != null) return drawtextCached;
  try {
    const { stdout, stderr } = await execFileAsync(
      ffmpeg,
      ['-hide_banner', '-filters'],
      { timeout: 15_000, maxBuffer: 4 * 1024 * 1024 }
    );
    const out = `${stdout || ''}\n${stderr || ''}`;
    drawtextCached = /\bdrawtext\b/i.test(out);
  } catch {
    drawtextCached = false;
  }
  if (!drawtextCached) {
    console.log(
      '[content-video] drawtext not in this ffmpeg — reels = image + voice (caption in post text)'
    );
  }
  return drawtextCached;
}

/**
 * Low-memory reels for Render Starter (~512MB).
 * 720x1280 + ultrafast + 1 thread keeps ffmpeg under OOM.
 * Override: CONTENT_VIDEO_HEIGHT=1920 for full HD on larger plans.
 */
function reelSize() {
  const h = Number(process.env.CONTENT_VIDEO_HEIGHT || 1280);
  if (h >= 1800) return { w: 1080, h: 1920 };
  return { w: 720, h: 1280 };
}

function baseVideoFilters() {
  const { w, h } = reelSize();
  return [
    `scale=${w}:${h}:force_original_aspect_ratio=increase`,
    `crop=${w}:${h}`,
    // Slight darken so white caption text stays readable on parchment/cross stills
    'eq=brightness=-0.06:saturation=1.05',
  ].join(',');
}

/**
 * Probe audio duration via ffmpeg (prints Duration on stderr, exits non-zero).
 */
async function probeAudioDurationSec(ffmpeg, audioPath) {
  try {
    await execFileAsync(ffmpeg, ['-i', audioPath], {
      timeout: 20_000,
      maxBuffer: 2 * 1024 * 1024,
    });
  } catch (e) {
    const err = `${e.stderr || ''}\n${e.message || ''}`;
    const m = err.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/);
    if (m) {
      const sec = Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]);
      if (Number.isFinite(sec) && sec > 0.4) return sec;
    }
  }
  return null;
}

async function runFfmpegReel(opts) {
  // threads=1 + ultrafast: critical on 512MB so Node + ffmpeg don't OOM
  // Explicit -map ensures voice is never dropped. -t matches audio length.
  const args = [
    '-y',
    '-framerate',
    '30',
    '-loop',
    '1',
    '-i',
    opts.imagePath,
    '-i',
    opts.audioPath,
    '-map',
    '0:v:0',
    '-map',
    '1:a:0',
    '-c:v',
    'libx264',
    '-preset',
    'ultrafast',
    '-tune',
    'stillimage',
    '-crf',
    '26',
    '-threads',
    '1',
    '-pix_fmt',
    'yuv420p',
    '-r',
    '30',
    '-c:a',
    'aac',
    '-b:a',
    '128k',
    '-ac',
    '1',
    '-ar',
    '44100',
    '-shortest',
    '-movflags',
    '+faststart',
  ];
  if (opts.durationSec && Number(opts.durationSec) > 0.5) {
    // Pad a hair so last syllable isn't cut
    args.push('-t', String(Math.min(90, Number(opts.durationSec) + 0.35)));
  }
  // Still may already have text baked in — only scale if needed
  if (opts.vf) {
    args.push('-vf', opts.vf);
  }
  args.push(opts.outPath);

  await execFileAsync(opts.ffmpeg, args, {
    timeout: 180_000,
    maxBuffer: 2 * 1024 * 1024,
    env: {
      ...process.env,
      OMP_NUM_THREADS: '1',
    },
  });
}

/**
 * Burn Q/A + brand + site onto the still with Jimp (works without ffmpeg drawtext).
 * Uses an opaque dark panel + shadow text so JPEG (no alpha) still shows readable copy.
 */
async function bakeTextOntoStill(imagePath, overlayText, outPath) {
  const { w, h } = reelSize();
  const img = await Jimp.read(imagePath);
  img.cover(w, h);

  // Opaque dark panel (JPEG drops alpha — never use translucent cards)
  const panelTop = Math.floor(h * 0.44);
  const panelH = h - panelTop - 20;
  const panelX = 16;
  const panelW = w - 32;
  // Warm near-black so it matches the brand still
  const panel = new Jimp(panelW, panelH, 0x140e08ff);
  // Gold-ish top edge bar
  const bar = new Jimp(panelW, 6, 0xc9a227ff);
  panel.composite(bar, 0, 0);
  img.composite(panel, panelX, panelTop);

  const fontWhite = await Jimp.loadFont(Jimp.FONT_SANS_32_WHITE);
  const fontWhiteSm = await Jimp.loadFont(Jimp.FONT_SANS_16_WHITE);
  let fontBlack = null;
  let fontBlackSm = null;
  try {
    fontBlack = await Jimp.loadFont(Jimp.FONT_SANS_32_BLACK);
    fontBlackSm = await Jimp.loadFont(Jimp.FONT_SANS_16_BLACK);
  } catch {
    /* optional shadow */
  }

  const lines = String(overlayText || '')
    .split('\n')
    .map((s) => s.trimEnd())
    .filter((s, i, arr) => s || (i > 0 && arr[i - 1])) // keep single blank gaps
    .slice(0, 14);

  if (!lines.some((l) => l && l.trim())) {
    lines.push('The Word in Context', 'thewordincontext.org');
  }

  let y = panelTop + 28;
  for (const line of lines) {
    if (!line || !line.trim()) {
      y += 14;
      continue;
    }
    const isFooter =
      /the word in context/i.test(line) || /thewordincontext/i.test(line);
    const fW = isFooter ? fontWhiteSm : fontWhite;
    const fB = isFooter ? fontBlackSm : fontBlack;
    const lineH = isFooter ? 26 : 42;

    // Truncate lines that are wider than the panel
    let text = line;
    let tw = Jimp.measureText(fW, text);
    const maxTw = panelW - 36;
    while (tw > maxTw && text.length > 8) {
      text = `${text.slice(0, -2)}…`;
      tw = Jimp.measureText(fW, text);
    }
    const x = panelX + Math.max(12, Math.floor((panelW - tw) / 2));

    // Drop shadow then white glyph (simple print — alignment object can fail silently)
    if (fB) img.print(fB, x + 2, y + 2, text);
    img.print(fW, x, y, text);

    y += lineH;
    if (y > h - 36) break;
  }

  await img.quality(90).writeAsync(outPath);
  if (!fs.existsSync(outPath) || fs.statSync(outPath).size < 2000) {
    throw new Error('Failed to bake text onto still (empty file)');
  }

  // Verify we actually painted light pixels in the panel (catch silent font failures)
  const check = await Jimp.read(outPath);
  let bright = 0;
  check.scan(panelX + 8, panelTop + 8, panelW - 16, Math.min(panelH - 16, 500), function (
    _x,
    _y,
    idx
  ) {
    const r = this.bitmap.data[idx];
    const g = this.bitmap.data[idx + 1];
    const b = this.bitmap.data[idx + 2];
    if (r + g + b > 420) bright += 1;
  });
  if (bright < 400) {
    throw new Error(
      `Text bake produced too few light pixels (${bright}) — fonts may have failed`
    );
  }
  console.log('[content-video] text baked', outPath, `bright=${bright}`);
  return outPath;
}

/** Only one reel encode at a time (ffmpeg is heavy). */
let videoBusy = false;

function resolveDataDir() {
  if (process.env.DATA_DIR) return process.env.DATA_DIR;
  if (fs.existsSync('/data')) return '/data';
  return path.join(__dirname, '..', 'data');
}

function videoDir() {
  const dir = path.join(resolveDataDir(), 'content-videos');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function resolveFont() {
  const candidates = [
    '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf',
    '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf',
    '/System/Library/Fonts/Supplemental/Arial Bold.ttf',
    '/System/Library/Fonts/Supplemental/Arial.ttf',
    '/Library/Fonts/Arial.ttf',
  ];
  for (const f of candidates) {
    if (fs.existsSync(f)) return f;
  }
  return null;
}

function resolveImagePath(imageKey) {
  const keys = [
    imageKey,
    'share-bg-vertical.jpg',
    'share-bg-parchment.jpg',
    'share-og.png',
    'icon-512.png',
  ].filter(Boolean);
  const dirs = [
    path.join(__dirname, '..', 'public', 'content-media'),
    path.join(__dirname, '..', 'public', 'icons'),
    path.join(process.cwd(), 'public', 'content-media'),
    path.join(process.cwd(), 'public', 'icons'),
  ];
  for (const key of keys) {
    for (const dir of dirs) {
      const p = path.join(dir, key);
      if (fs.existsSync(p)) return p;
    }
  }
  return null;
}

function voiceScriptFromPost(post) {
  let t = (post.captionIg || post.caption || '').trim();
  t = t
    .replace(/https?:\/\/\S+/gi, '')
    .replace(/#[\w]+/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]+/g, ' ')
    .trim();
  if (t.length > 420) {
    const cut = t.slice(0, 400);
    const breakAt = Math.max(
      cut.lastIndexOf('. '),
      cut.lastIndexOf('! '),
      cut.lastIndexOf('? '),
      cut.lastIndexOf('\n')
    );
    t = (breakAt > 80 ? cut.slice(0, breakAt + 1) : cut).trim() + '…';
  }
  if (!t) {
    t =
      'The Word in Context. Hear the text. Study the words. Grow in understanding. Visit thewordincontext.org.';
  }
  return t;
}

/** Word-wrap a single line for drawtext (approx by chars). */
function wrapLine(line, maxChars = 28) {
  const words = String(line || '')
    .replace(/\s+/g, ' ')
    .trim()
    .split(' ')
    .filter(Boolean);
  if (!words.length) return [];
  const lines = [];
  let cur = '';
  for (const w of words) {
    const next = cur ? `${cur} ${w}` : w;
    if (next.length <= maxChars) cur = next;
    else {
      if (cur) lines.push(cur);
      cur = w.length > maxChars ? `${w.slice(0, maxChars - 1)}…` : w;
    }
  }
  if (cur) lines.push(cur);
  return lines;
}

/**
 * Multi-line card text burned onto reels.
 * Without this, Starter-plan reels are only the background still (looks "blank").
 */
function overlayTextFromPost(post) {
  const raw = (post.caption || post.captionIg || '').trim();
  const linesIn = raw
    .split('\n')
    .map((s) => s.trim())
    .filter((s) => s && !s.startsWith('#') && !/^https?:/i.test(s));

  let q =
    linesIn.find((s) => /^Q:\s*/i.test(s)) ||
    (post.question ? `Q: ${post.question}` : '') ||
    linesIn[0] ||
    '';
  q = q.replace(/^Q:\s*/i, 'Q: ').replace(/#[\w]+/g, '').trim();

  let a = linesIn.find((s) => /^A:\s*/i.test(s)) || '';
  a = a.replace(/^A:\s*/i, 'A: ').replace(/#[\w]+/g, '').trim();

  const bodyLines = [];
  for (const piece of wrapLine(q, 30).slice(0, 3)) bodyLines.push(piece);
  if (a) {
    bodyLines.push('');
    for (const piece of wrapLine(a, 30).slice(0, 4)) bodyLines.push(piece);
  }
  if (!bodyLines.length) {
    bodyLines.push('Study Scripture', 'in context');
  }

  // Footer always on the card
  bodyLines.push('');
  bodyLines.push('The Word in Context');
  bodyLines.push('thewordincontext.org');

  // Cap total lines so drawtext stays light on RAM
  const capped = bodyLines.slice(0, 12);
  return capped.join('\n') || 'The Word in Context\nthewordincontext.org';
}

/** Whether to burn caption text onto the reel (default: ON). */
function allowTextOverlay(canDraw, font) {
  if (!canDraw || !font) return false;
  // Explicit off only
  if (process.env.CONTENT_VIDEO_OVERLAY === '0') return false;
  // Default ON for 720p and 1080p — blank stills without text look empty on IG/TikTok
  return true;
}

async function synthesizeVoiceMp3(script, outPath) {
  const key = (process.env.XAI_API_KEY || '').trim();
  if (!key) throw new Error('XAI_API_KEY required for video voice-over');

  // Built-in voices first — cloned SHARE_TTS_VOICE ids often fail in batch reels
  // (admin share voice is separate; content reels need a reliable default).
  const preferredRaw = (
    process.env.CONTENT_VIDEO_VOICE ||
    process.env.SHARE_TTS_VOICE ||
    'leo'
  ).trim();
  const preferred = preferredRaw || 'leo';
  const builtins = ['leo', 'rex', 'ara', 'eve', 'sal'];
  const chain = [];
  const push = (v) => {
    const id = String(v || '').trim();
    if (id && !chain.includes(id)) chain.push(id);
  };
  // If preferred is a short built-in name, try it first; long hash-like IDs go last
  if (builtins.includes(preferred.toLowerCase())) push(preferred.toLowerCase());
  for (const b of builtins) push(b);
  if (!builtins.includes(preferred.toLowerCase())) push(preferred);

  const speak = String(script || '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 900);
  if (!speak) throw new Error('Empty voice script for TTS');

  async function call(voiceId) {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 45_000);
    try {
      return await fetch('https://api.x.ai/v1/tts', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${key}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          text: speak,
          voice_id: voiceId,
          language: 'en',
          speed: 0.98,
          output_format: {
            codec: 'mp3',
            sample_rate: 24000,
            bit_rate: 128000,
          },
        }),
        signal: ac.signal,
      });
    } finally {
      clearTimeout(timer);
    }
  }

  let lastErr = '';
  for (const voiceId of chain) {
    try {
      const res = await call(voiceId);
      if (!res.ok) {
        lastErr = `${voiceId} HTTP ${res.status} ${(await res.text().catch(() => '')).slice(0, 120)}`;
        console.warn('[content-video] TTS try failed', lastErr);
        continue;
      }
      const buf = Buffer.from(await res.arrayBuffer());
      // Reject tiny/error payloads
      if (!buf.length || buf.length < 500) {
        lastErr = `${voiceId} empty/tiny audio (${buf.length}b)`;
        continue;
      }
      // MP3 files usually start with ID3 or 0xFFEx
      const head = buf.slice(0, 3).toString('ascii');
      const isMp3 =
        head.startsWith('ID3') || buf[0] === 0xff || buf[0] === 0x49;
      if (!isMp3) {
        lastErr = `${voiceId} not mp3 (${head})`;
        console.warn('[content-video] TTS non-mp3', lastErr, buf.slice(0, 80).toString('utf8'));
        continue;
      }
      fs.writeFileSync(outPath, buf);
      console.log('[content-video] TTS ok', voiceId, `${buf.length}b`);
      return { voiceId, bytes: buf.length };
    } catch (e) {
      lastErr = `${voiceId} ${e && e.name === 'AbortError' ? 'timeout' : e.message || e}`;
      console.warn('[content-video] TTS error', lastErr);
    }
  }
  throw new Error(`TTS failed for all voices: ${lastErr || 'unknown'}`);
}

function publicVideoUrl(fileName) {
  const base = (PUBLIC_URL || '').replace(/\/$/, '');
  return `${base}/content-media/videos/${encodeURIComponent(fileName)}`;
}

async function generateVideoForPost(post) {
  const ffmpeg = resolveFfmpeg();
  if (!ffmpeg) {
    return {
      ok: false,
      postId: post.id,
      error: 'ffmpeg-static not available — run npm install ffmpeg-static',
    };
  }

  const imagePath = resolveImagePath(post.imageKey);
  if (!imagePath) {
    return {
      ok: false,
      postId: post.id,
      error: `Image not found for ${post.imageKey || '(none)'}`,
    };
  }

  const dir = videoDir();
  const id = post.id.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 40) || 'post';
  const stamp = Date.now().toString(36);
  const fileName = `${id}-${stamp}.mp4`;
  const outPath = path.join(dir, fileName);
  const audioPath = path.join(dir, `${id}-${stamp}.mp3`);
  const stillPath = path.join(dir, `${id}-${stamp}-card.jpg`);
  const textPath = path.join(dir, `${id}-${stamp}.txt`);

  const voiceScript = voiceScriptFromPost(post);
  const overlay = overlayTextFromPost(post);

  try {
    // 1) Voice first — fail hard if no audio (do not ship silent “blank” reels)
    const tts = await synthesizeVoiceMp3(voiceScript, audioPath);
    if (!fs.existsSync(audioPath) || fs.statSync(audioPath).size < 500) {
      throw new Error('TTS wrote no usable audio file');
    }

    // 2) Bake Q/A + brand + URL onto still — REQUIRED (do not ship voice-only blank stills)
    fs.writeFileSync(textPath, overlay, 'utf8');
    let usedOverlay = false;
    if (process.env.CONTENT_VIDEO_OVERLAY === '0') {
      console.warn('[content-video] CONTENT_VIDEO_OVERLAY=0 — text disabled by env');
    } else {
      try {
        await bakeTextOntoStill(imagePath, overlay, stillPath);
        usedOverlay = true;
      } catch (bakeErr) {
        console.warn(
          '[content-video] Jimp bake failed, trying drawtext',
          bakeErr.message || bakeErr
        );
        const font = resolveFont();
        const canDraw = (await ffmpegHasDrawtext(ffmpeg)) && Boolean(font);
        if (!canDraw) {
          throw new Error(
            `Could not put text on reel: ${bakeErr.message || bakeErr}. ` +
              'Install fonts or fix jimp. Refusing silent background-only reel.'
          );
        }
        // drawtext path encodes in one step below
        usedOverlay = 'drawtext';
      }
    }

    // 3) Encode still + voice
    const durationSec =
      (await probeAudioDurationSec(ffmpeg, audioPath)) ||
      Math.max(6, Math.ceil(voiceScript.length / 14));
    const { w, h } = reelSize();

    if (usedOverlay === 'drawtext') {
      const font = resolveFont();
      const fontEsc = font.replace(/\\/g, '/').replace(/:/g, '\\:');
      const textEsc = textPath.replace(/\\/g, '/').replace(/:/g, '\\:');
      const vf =
        `${baseVideoFilters()},` +
        `drawtext=fontfile='${fontEsc}':textfile='${textEsc}':reload=0:` +
        `fontsize=32:fontcolor=white:borderw=3:bordercolor=black@0.95:` +
        `line_spacing=10:x=(w-text_w)/2:y=h*0.52:` +
        `box=1:boxcolor=black@0.75:boxborderw=18`;
      await runFfmpegReel({
        ffmpeg,
        imagePath,
        audioPath,
        outPath,
        vf,
        durationSec,
      });
      usedOverlay = true;
    } else {
      const stillForVideo = usedOverlay ? stillPath : imagePath;
      // Baked JPEG is already 720x1280 — avoid filters that could drop detail; only pad if needed
      const vf = usedOverlay
        ? `scale=${w}:${h}:force_original_aspect_ratio=decrease,pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2:color=0x140e08`
        : baseVideoFilters();
      await runFfmpegReel({
        ffmpeg,
        imagePath: stillForVideo,
        audioPath,
        outPath,
        vf,
        durationSec,
      });
    }

    if (!usedOverlay) {
      console.warn(
        '[content-video] WARNING: reel encoded without text overlay (CONTENT_VIDEO_OVERLAY=0?)'
      );
    }

    if (!fs.existsSync(outPath) || fs.statSync(outPath).size < 2000) {
      throw new Error('ffmpeg produced empty or missing file');
    }

    // Soft check: file should be big enough to include audio (rough)
    const mp4Size = fs.statSync(outPath).size;
    if (mp4Size < 8000) {
      console.warn('[content-video] suspiciously small mp4', mp4Size, 'tts', tts);
    }

    const videoUrl = publicVideoUrl(fileName);
    // Re-queue so Publish / auto-push can send the reel (image-only Buffer
    // posts leave status=scheduled + externalIds, which used to skip video).
    const wasPublished = ['scheduled', 'posted'].includes(post.status);
    updatePost(post.id, {
      videoKey: fileName,
      videoUrl,
      voiceScript,
      status: wasPublished || post.status === 'failed' ? 'queued' : post.status,
      externalIds: wasPublished ? undefined : post.externalIds,
      networksRemaining: undefined,
      error: undefined,
      meta: {
        ...(post.meta || {}),
        videoGeneratedAt: new Date().toISOString(),
        // true if text baked, or if operator disabled overlay (done, don't re-upgrade loop)
        videoHasTextOverlay:
          Boolean(usedOverlay) || process.env.CONTENT_VIDEO_OVERLAY === '0',
        videoVoiceId: tts?.voiceId || null,
        videoPublishedToBuffer: false,
        priorExternalIds: wasPublished
          ? post.externalIds || post.meta?.priorExternalIds
          : post.meta?.priorExternalIds,
      },
    });

    try {
      if (fs.existsSync(audioPath)) fs.unlinkSync(audioPath);
      if (fs.existsSync(textPath)) fs.unlinkSync(textPath);
      if (fs.existsSync(stillPath)) fs.unlinkSync(stillPath);
    } catch {
      /* ignore */
    }

    try {
      const files = fs
        .readdirSync(dir)
        .filter((f) => f.endsWith('.mp4'))
        .map((f) => ({ f, t: fs.statSync(path.join(dir, f)).mtimeMs }))
        .sort((a, b) => b.t - a.t);
      // Keep only last 12 reels on disk (disk + inode + RAM pressure)
      for (const old of files.slice(12)) {
        fs.unlinkSync(path.join(dir, old.f));
      }
    } catch {
      /* ignore */
    }

    if (typeof global.gc === 'function') {
      try {
        global.gc();
      } catch {
        /* ignore */
      }
    }

    console.log('[content-video] ok', post.id, fileName, videoUrl);
    return {
      ok: true,
      postId: post.id,
      videoUrl,
      videoKey: fileName,
      voiceScript,
      durationHintSec: Math.ceil(voiceScript.length / 14),
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[content-video] failed', post.id, msg);
    try {
      if (fs.existsSync(audioPath)) fs.unlinkSync(audioPath);
      if (fs.existsSync(textPath)) fs.unlinkSync(textPath);
      if (fs.existsSync(stillPath)) fs.unlinkSync(stillPath);
      if (fs.existsSync(outPath) && fs.statSync(outPath).size < 2000) {
        fs.unlinkSync(outPath);
      }
    } catch {
      /* ignore */
    }
    return { ok: false, postId: post.id, error: msg, voiceScript };
  }
}

function needsVideo(post, opts = {}) {
  if (!post) return false;
  if (!post.videoUrl) return true;
  if (opts.force) return true;
  // Upgrade blank stills from the old no-text pipeline
  if (opts.upgradeBlank !== false) {
    // false or missing = treat as blank (pre-Jimp reels)
    if (post.meta?.videoHasTextOverlay !== true) return true;
  }
  return false;
}

/**
 * Generate reels for queued posts.
 * Default limit=1 on small instances so one ffmpeg encode can't OOM the box.
 * Upgrades blank (no-text) reels by default so Buffer gets scroll-stopping cards.
 */
async function generateVideosForQueued(opts = {}) {
  if (videoBusy) {
    return {
      results: [
        {
          ok: false,
          postId: '',
          error:
            'Video encode already running. Wait for it to finish, then click Generate videos again.',
        },
      ],
      ffmpeg: Boolean(resolveFfmpeg()),
      busy: true,
    };
  }

  const defaultLimit = Number(process.env.CONTENT_VIDEO_BATCH || 1);
  const limit = Math.min(
    Math.max(1, Number(opts.limit) || defaultLimit || 1),
    3
  ); // hard cap 3/request on Starter
  const posts = listPosts({ limit: 40 }).filter((p) =>
    ['queued', 'failed', 'draft', 'scheduled'].includes(p.status)
  );
  const pickOpts = {
    force: Boolean(opts.force),
    upgradeBlank: opts.upgradeBlank !== false,
  };
  const need = posts
    .filter((p) => needsVideo(p, pickOpts))
    .sort((a, b) => {
      const aBlank = a.videoUrl ? 1 : 0;
      const bBlank = b.videoUrl ? 1 : 0;
      return aBlank - bBlank;
    })
    .slice(0, limit);
  const remaining =
    posts.filter((p) => needsVideo(p, pickOpts)).length - need.length;

  videoBusy = true;
  const results = [];
  try {
    for (const p of need) {
      results.push(await generateVideoForPost(p));
      // Let OS reclaim pages between encodes
      await new Promise((r) => setTimeout(r, 800));
      if (typeof global.gc === 'function') {
        try {
          global.gc();
        } catch {
          /* ignore */
        }
      }
    }
  } finally {
    videoBusy = false;
  }

  return {
    results,
    ffmpeg: Boolean(resolveFfmpeg()),
    remainingWithoutVideo: Math.max(0, remaining),
    tip:
      remaining > 0
        ? `Made ${results.filter((r) => r.ok).length} reel(s). ${remaining} still need video — click Generate videos again (1 at a time keeps RAM low).`
        : undefined,
  };
}

function contentVideoStatus() {
  const dir = videoDir();
  let videoCount = 0;
  try {
    videoCount = fs.readdirSync(dir).filter((f) => f.endsWith('.mp4')).length;
  } catch {
    videoCount = 0;
  }
  const { w, h } = reelSize();
  return {
    ffmpeg: Boolean(resolveFfmpeg()),
    font: Boolean(resolveFont()),
    drawtext: drawtextCached,
    jimpTextBake: true,
    videoCount,
    dir,
    size: `${w}x${h}`,
    batchDefault: Number(process.env.CONTENT_VIDEO_BATCH || 1),
    busy: videoBusy,
    note:
      'Reels: Jimp burns Q/A + site onto the still, then xAI TTS voice is muxed with ffmpeg. 1 video/request on Starter — click Generate videos again for the next.',
  };
}

/** List MP4s on disk with public download URLs (for manual Buffer upload). */
function listVideoFiles() {
  const dir = videoDir();
  const base = (PUBLIC_URL || '').replace(/\/$/, '');
  let files = [];
  try {
    files = fs
      .readdirSync(dir)
      .filter((f) => f.endsWith('.mp4') && !f.startsWith('_'))
      .map((f) => {
        const st = fs.statSync(path.join(dir, f));
        return {
          fileName: f,
          bytes: st.size,
          mtime: st.mtime.toISOString(),
          url: `${base}/content-media/videos/${encodeURIComponent(f)}`,
          downloadUrl: `${base}/content-media/videos/${encodeURIComponent(f)}?download=1`,
        };
      })
      .sort((a, b) => (b.mtime || '').localeCompare(a.mtime || ''));
  } catch {
    files = [];
  }
  const posts = listPosts({ limit: 80 })
    .filter((p) => p.videoUrl || p.videoKey)
    .map((p) => ({
      id: p.id,
      targetDate: p.targetDate,
      status: p.status,
      videoKey: p.videoKey,
      videoUrl: p.videoUrl,
      caption: (p.caption || '').slice(0, 100),
    }));
  return { dir, files, posts, count: files.length };
}

module.exports = {
  generateVideoForPost,
  generateVideosForQueued,
  contentVideoStatus,
  listVideoFiles,
  videoDir,
  resolveFfmpeg,
};
