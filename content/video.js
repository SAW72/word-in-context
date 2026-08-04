/**
 * Talking-card reels for The Word in Context content → Buffer/TikTok.
 * Brand still + xAI TTS → 9:16 H.264 MP4 (public URL).
 * Port of IA contentVideoService (CommonJS).
 */
const { execFile } = require('child_process');
const { promisify } = require('util');
const fs = require('fs');
const path = require('path');
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
    'eq=brightness=0.02:saturation=1.05',
  ].join(',');
}

async function runFfmpegReel(opts) {
  // threads=1 + ultrafast: critical on 512MB so Node + ffmpeg don't OOM
  await execFileAsync(
    opts.ffmpeg,
    [
      '-y',
      '-loop',
      '1',
      '-i',
      opts.imagePath,
      '-i',
      opts.audioPath,
      '-vf',
      opts.vf,
      '-c:v',
      'libx264',
      '-preset',
      'ultrafast',
      '-tune',
      'stillimage',
      '-crf',
      '28',
      '-threads',
      '1',
      '-pix_fmt',
      'yuv420p',
      '-c:a',
      'aac',
      '-b:a',
      '96k',
      '-ac',
      '1',
      '-shortest',
      '-movflags',
      '+faststart',
      opts.outPath,
    ],
    {
      timeout: 180_000,
      maxBuffer: 2 * 1024 * 1024,
      env: {
        ...process.env,
        OMP_NUM_THREADS: '1',
      },
    }
  );
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
      'Trail Tracker. The Word in Context. Hear the text. Study the words. Grow in understanding.';
  }
  return t;
}

function overlayTextFromPost(post) {
  const raw = (post.caption || post.captionIg || '').trim();
  const line = raw
    .split('\n')
    .map((s) => s.trim())
    .find((s) => s && !s.startsWith('#') && !/^https?:/i.test(s));
  let t = (line || raw).replace(/#[\w]+/g, '').trim();
  if (t.length > 90) t = t.slice(0, 87).trim() + '…';
  return t || 'The Word in Context';
}

async function synthesizeVoiceMp3(script, outPath) {
  const key = (process.env.XAI_API_KEY || '').trim();
  if (!key) throw new Error('XAI_API_KEY required for video voice-over');

  const voice =
    (process.env.CONTENT_VIDEO_VOICE || process.env.SHARE_TTS_VOICE || 'leo').trim() ||
    'leo';

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
          text: script,
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

  let res = await call(voice);
  if (!res.ok && voice.toLowerCase() !== 'leo') {
    console.warn('[content-video] voice failed, retry leo', res.status);
    res = await call('leo');
  }
  if (!res.ok) {
    const err = await res.text().catch(() => '');
    throw new Error(`TTS failed ${res.status}: ${err.slice(0, 200)}`);
  }
  const buf = Buffer.from(await res.arrayBuffer());
  if (!buf.length) throw new Error('Empty TTS audio');
  fs.writeFileSync(outPath, buf);
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
  const textPath = path.join(dir, `${id}-${stamp}.txt`);

  const voiceScript = voiceScriptFromPost(post);
  const overlay = overlayTextFromPost(post);

  try {
    await synthesizeVoiceMp3(voiceScript, audioPath);
    fs.writeFileSync(textPath, overlay, 'utf8');

    const font = resolveFont();
    const canDraw = (await ffmpegHasDrawtext(ffmpeg)) && Boolean(font);
    const vfBase = baseVideoFilters();
    let usedOverlay = false;

    try {
      // Skip drawtext on small instances — overlay doubles peak RAM
      const allowOverlay =
        canDraw &&
        font &&
        process.env.CONTENT_VIDEO_OVERLAY !== '0' &&
        Number(process.env.CONTENT_VIDEO_HEIGHT || 1280) >= 1800;
      if (allowOverlay && font) {
        const fontEsc = font.replace(/\\/g, '/').replace(/:/g, '\\:');
        const textEsc = textPath.replace(/\\/g, '/').replace(/:/g, '\\:');
        const vfWithText = `${vfBase},drawtext=fontfile='${fontEsc}':textfile='${textEsc}':reload=0:fontsize=36:fontcolor=white:borderw=2:bordercolor=black@0.85:line_spacing=8:x=(w-text_w)/2:y=h*0.70:box=1:boxcolor=black@0.45:boxborderw=12`;
        await runFfmpegReel({
          ffmpeg,
          imagePath,
          audioPath,
          outPath,
          vf: vfWithText,
        });
        usedOverlay = true;
      } else {
        await runFfmpegReel({
          ffmpeg,
          imagePath,
          audioPath,
          outPath,
          vf: vfBase,
        });
      }
    } catch (firstErr) {
      const msg = firstErr instanceof Error ? firstErr.message : String(firstErr);
      if (/drawtext|No such filter/i.test(msg) || usedOverlay || canDraw) {
        console.warn(
          '[content-video] overlay failed, image+audio only',
          msg.slice(0, 120)
        );
        drawtextCached = false;
        await runFfmpegReel({
          ffmpeg,
          imagePath,
          audioPath,
          outPath,
          vf: vfBase,
        });
        usedOverlay = false;
      } else {
        throw firstErr;
      }
    }

    if (!fs.existsSync(outPath) || fs.statSync(outPath).size < 1000) {
      throw new Error('ffmpeg produced empty or missing file');
    }

    const videoUrl = publicVideoUrl(fileName);
    updatePost(post.id, {
      videoKey: fileName,
      videoUrl,
      voiceScript,
      meta: {
        ...(post.meta || {}),
        videoGeneratedAt: new Date().toISOString(),
        videoHasTextOverlay: usedOverlay,
      },
    });

    try {
      fs.unlinkSync(audioPath);
      fs.unlinkSync(textPath);
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
    } catch {
      /* ignore */
    }
    return { ok: false, postId: post.id, error: msg, voiceScript };
  }
}

/**
 * Generate reels for queued posts.
 * Default limit=1 on small instances so one ffmpeg encode can't OOM the box.
 * Admin can call repeatedly to fill the week (Generate next video).
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
  const need = posts.filter((p) => !p.videoUrl).slice(0, limit);
  const remaining = posts.filter((p) => !p.videoUrl).length - need.length;

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
    videoCount,
    dir,
    size: `${w}x${h}`,
    batchDefault: Number(process.env.CONTENT_VIDEO_BATCH || 1),
    busy: videoBusy,
    note:
      'Low-memory mode: 720x1280, 1 video/request by default. Click Generate videos repeatedly to finish the week. CONTENT_VIDEO_HEIGHT=1920 on larger plans.',
  };
}

module.exports = {
  generateVideoForPost,
  generateVideosForQueued,
  contentVideoStatus,
  videoDir,
  resolveFfmpeg,
};
