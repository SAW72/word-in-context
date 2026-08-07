/**
 * Content API for The Word in Context.
 * Auth: same as other admin routes — Authorization: Bearer <admin JWT>
 */
const path = require('path');
const fs = require('fs');
const { CONTENT_BRAND, PUBLIC_URL } = require('./brand');
const { listPosts, loadQueue, getPost, requeuePostsForNetworks } = require('./queue');
const { generatePosts, buildCopyPack, countByStatus } = require('./generator');
const {
  isConfigured,
  bufferHealth,
  publishPost,
  publishQueued,
} = require('./buffer');
const {
  generateVideosForQueued,
  contentVideoStatus,
  listVideoFiles,
  videoDir,
} = require('./video');

/**
 * @param {import('express').Application} app
 * @param {{ requireAdmin: (req: any, res: any) => boolean }} deps
 */
function mountContentRoutes(app, { requireAdmin }) {
  const express = require('express');

  // Generated reels first (public so Buffer / Mac download can fetch MP4s)
  try {
    const vdir = videoDir();
    app.use('/content-media/videos', (req, res, next) => {
      if (req.query.download === '1' || req.query.download === 'true') {
        res.setHeader('Content-Disposition', 'attachment');
      }
      next();
    });
    app.use(
      '/content-media/videos',
      express.static(vdir, {
        maxAge: '1d',
        index: false,
        fallthrough: true,
        setHeaders(res) {
          res.setHeader('Access-Control-Allow-Origin', '*');
        },
      })
    );
    app.use('/content-media/videos', (_req, res) => {
      res.status(404).json({ error: 'Video not found' });
    });
    console.log(`[content] videos → ${vdir}`);
  } catch (e) {
    console.warn('[content] video dir', e.message);
  }

  /** List reel MP4s + public URLs (manual Buffer upload / Mac download). */
  app.get('/api/content/videos', (req, res) => {
    if (!requireAdmin(req, res)) return;
    try {
      const listed = listVideoFiles();
      res.json({
        ok: true,
        ...listed,
        zipUrl: '/api/content/videos/zip',
        tip:
          listed.count > 0
            ? 'Download ZIP or open each URL on your Mac, then upload to Buffer.'
            : 'No reels on disk yet — Generate videos first.',
      });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  /** ZIP all reels for one-click Mac download. */
  app.get('/api/content/videos/zip', (req, res) => {
    if (!requireAdmin(req, res)) return;
    void (async () => {
      try {
        const { execFile } = require('child_process');
        const { promisify } = require('util');
        const execFileAsync = promisify(execFile);
        const listed = listVideoFiles();
        if (!listed.files.length) {
          res.status(404).json({
            error: 'No reels on disk. Generate videos first, then download.',
          });
          return;
        }
        const dir = videoDir();
        const stamp = new Date().toISOString().slice(0, 10);
        const zipName = `word-in-context-reels-${stamp}.zip`;
        const zipPath = path.join(dir, `_${zipName}`);
        const names = listed.files.map((f) => f.fileName);
        try {
          await execFileAsync('zip', ['-j', '-q', zipPath, ...names], {
            cwd: dir,
            timeout: 120_000,
            maxBuffer: 4 * 1024 * 1024,
          });
        } catch (zipErr) {
          const msg = zipErr instanceof Error ? zipErr.message : String(zipErr);
          if (/ENOENT|zip/i.test(msg) && listed.files[0]) {
            res.download(
              path.join(dir, listed.files[0].fileName),
              listed.files[0].fileName
            );
            return;
          }
          throw zipErr;
        }
        res.download(zipPath, zipName, (err) => {
          try {
            if (fs.existsSync(zipPath)) fs.unlinkSync(zipPath);
          } catch {
            /* ignore */
          }
          if (err && !res.headersSent) {
            res.status(500).json({ error: err.message });
          }
        });
      } catch (e) {
        res.status(500).json({ error: e.message });
      }
    })();
  });

  const mediaDirs = [
    path.join(__dirname, '..', 'public', 'icons'),
    path.join(__dirname, '..', 'public', 'content-media'),
  ];
  for (const dir of mediaDirs) {
    if (fs.existsSync(dir)) {
      app.use('/content-media', express.static(dir, { maxAge: '7d', index: false }));
      console.log(`[content] media → ${dir}`);
      break;
    }
  }

  app.get('/api/content/status', (req, res) => {
    if (!requireAdmin(req, res)) return;
    void (async () => {
      try {
        const health = await bufferHealth();
        const video = contentVideoStatus();
        res.json({
          brand: {
            id: CONTENT_BRAND.id,
            name: CONTENT_BRAND.name,
            networks: CONTENT_BRAND.networks,
            website: CONTENT_BRAND.website,
            format: 'Bible Q&A',
          },
          buffer: health,
          bufferConfigured: isConfigured(),
          queue: {
            total: loadQueue().posts.length,
            byStatus: countByStatus(),
          },
          video,
          publicUrl: PUBLIC_URL,
          xaiConfigured: Boolean((process.env.XAI_API_KEY || '').trim()),
          tips: [
            'Separate Buffer FB/IG for The Word in Context (not IA or Trail Tracker).',
            'BUFFER_API_KEY + XAI_API_KEY on Render. SHARE_SITE_URL for image/video URLs.',
            'Flow: Generate week → Generate videos (auto-pushes reels to Buffer).',
            'Posts are Q: question / A: short study answer + trial CTA.',
          ],
        });
      } catch (e) {
        res.status(500).json({ error: e.message });
      }
    })();
  });

  app.get('/api/content/buffer/test', (req, res) => {
    if (!requireAdmin(req, res)) return;
    void (async () => {
      try {
        if (!isConfigured()) {
          return res.status(400).json({ ok: false, error: 'BUFFER_API_KEY not set' });
        }
        const health = await bufferHealth();
        const ready = Boolean(health.facebook || health.instagram || health.x);
        res.json({
          ok: !health.error && ready,
          ...health,
          next: ready
            ? 'Ready — Generate week → Publish queued (set CONTENT_NETWORKS=facebook,instagram,x for X)'
            : 'Connect FB/IG/X in Buffer first',
        });
      } catch (e) {
        res.status(500).json({ ok: false, error: e.message });
      }
    })();
  });

  app.post('/api/content/buffer/smoke', (req, res) => {
    if (!requireAdmin(req, res)) return;
    void (async () => {
      try {
        if (!isConfigured()) {
          return res.status(400).json({ ok: false, error: 'BUFFER_API_KEY not set' });
        }
        const health = await bufferHealth();
        const imageUrl = `${PUBLIC_URL}/content-media/share-bg-vertical.jpg`;
        const smoke = {
          id: 'smoke',
          networks: [
            ...(health.facebook ? ['facebook'] : []),
            ...(health.instagram ? ['instagram'] : []),
            ...(health.x ? ['x'] : []),
            ...(health.tiktok ? ['tiktok'] : []),
          ],
          caption:
            'Q: Why does context matter when reading a single verse?\n\nA: Verses sit inside letters, stories, and arguments. Reading the surrounding passage protects us from slogan-theology.\n\n(Study aid — open the text yourself.)\n\nTry The Word in Context: voice-first Scripture study.\n' +
            PUBLIC_URL +
            '/app',
          captionIg:
            'Q: Why does context matter when reading a single verse?\n\nA: Verses sit inside letters, stories, and arguments.\n\nTry The Word in Context → ' +
            PUBLIC_URL +
            '/app',
          hashtags: ['#TheWordInContext', '#BibleStudy', '#Scripture'],
          imageKey: 'share-bg-vertical.jpg',
          imageUrl,
          scheduledAt: new Date(Date.now() + 3600_000).toISOString(),
        };
        if (!smoke.networks.length) {
          return res.status(400).json({ ok: false, error: 'No FB/IG/X channels', health });
        }
        const result = await publishPost(smoke);
        res.json({
          ok: result.ok,
          result,
          imageUrl,
          tip: result.ok
            ? 'Check Buffer, then Publish queued for the week.'
            : result.error,
        });
      } catch (e) {
        res.status(500).json({ ok: false, error: e.message });
      }
    })();
  });

  app.post('/api/content/generate', (req, res) => {
    if (!requireAdmin(req, res)) return;
    void (async () => {
      try {
        const days = Number(req.body?.days || 7);
        const mode = ['skip', 'force', 'replace'].includes(req.body?.mode)
          ? req.body.mode
          : 'replace';
        const result = await generatePosts({ days, mode });
        const pending = listPosts({ limit: 50 }).filter((p) =>
          ['queued', 'failed', 'draft'].includes(p.status)
        ).length;
        res.json({
          summary: {
            created: result.posts.length,
            days,
            mode,
            pendingPublish: pending,
          },
          warnings: result.warnings,
          posts: result.posts.map((p) => ({
            id: p.id,
            targetDate: p.targetDate,
            status: p.status,
            pillarId: p.pillarId,
            question: p.question,
            caption: p.caption?.slice(0, 140),
          })),
          tip:
            result.posts.length === 0 && pending > 0
              ? `You have ${pending} posts — tap Publish queued.`
              : result.posts.length
                ? 'Next: Publish queued'
                : undefined,
        });
      } catch (e) {
        res.status(500).json({ error: e.message });
      }
    })();
  });

  app.get('/api/content/posts', (req, res) => {
    if (!requireAdmin(req, res)) return;
    const limit = Math.min(Number(req.query.limit) || 20, 100);
    res.json({ posts: listPosts({ limit }) });
  });

  app.get('/api/content/export', (req, res) => {
    if (!requireAdmin(req, res)) return;
    const posts = listPosts({ limit: 60 }).filter((p) =>
      ['queued', 'failed', 'draft', 'scheduled'].includes(p.status)
    );
    res.json({ count: posts.length, pack: buildCopyPack(posts) });
  });

  /**
   * After Instagram reconnect: re-queue recent posts for Instagram only
   * (does not re-post to Facebook). Then tap Publish queued.
   */
  app.post('/api/content/requeue-instagram', (req, res) => {
    if (!requireAdmin(req, res)) return;
    try {
      const limit = Math.min(Number(req.body?.limit) || 14, 30);
      const { requeued, skipped } = requeuePostsForNetworks({
        networks: ['instagram'],
        limit,
      });
      res.json({
        ok: true,
        requeued: requeued.length,
        skipped,
        posts: requeued.map((p) => ({
          id: p.id,
          targetDate: p.targetDate,
          scheduledAt: p.scheduledAt,
          networks: p.networks,
          status: p.status,
        })),
        tip:
          requeued.length > 0
            ? 'Next: reconnect Instagram in Buffer if needed, then tap Publish queued. These go to Instagram only (not Facebook).'
            : 'No recent posts found to requeue. Generate week first, then try again.',
      });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  /**
   * Generate talking-card reels (still + TTS voice → 9:16 MP4).
   * Auto-pushes successful reels to Buffer unless body.publish === false.
   */
  app.post('/api/content/generate-videos', (req, res) => {
    if (!requireAdmin(req, res)) return;
    void (async () => {
      try {
        const limit = Math.min(Number(req.body?.limit) || 1, 3);
        const shouldPublish = req.body?.publish !== false;
        const out = await generateVideosForQueued({ limit });
        const ok = out.results.filter((r) => r.ok).length;
        const failed = out.results.filter((r) => !r.ok).length;
        const okIds = out.results.filter((r) => r.ok).map((r) => r.postId);

        let publishResults = [];
        let pushTip = '';
        if (shouldPublish && okIds.length && isConfigured()) {
          for (const id of okIds) {
            const post = getPost(id);
            if (!post?.videoUrl) continue;
            const r = await publishPost(post, { forceVideo: true });
            publishResults.push(r);
            await new Promise((resolve) => setTimeout(resolve, 500));
          }
          const videoAttached = publishResults.filter((r) => r.usedVideo).length;
          const pubOk = publishResults.filter((r) => r.ok).length;
          pushTip =
            videoAttached > 0
              ? `Pushed ${videoAttached} reel(s) to Buffer — check calendar/queue.`
              : pubOk > 0
                ? 'Buffer accepted posts as images only (video rejected). Check public MP4 URL.'
                : publishResults[0]?.error
                  ? `Buffer push failed: ${publishResults[0].error}`
                  : 'Videos ready — tap Publish queued if Buffer did not attach reels.';
        } else if (okIds.length && !isConfigured()) {
          pushTip = 'Videos on disk — set BUFFER_API_KEY or tap Publish queued.';
        }

        const video = contentVideoStatus();
        res.json({
          ok: ok > 0 || (out.results.length === 0 && !out.busy),
          summary: {
            ok,
            failed,
            attempted: out.results.length,
            remainingWithoutVideo: out.remainingWithoutVideo ?? 0,
            published: publishResults.filter((r) => r.ok).length,
            videosInBuffer: publishResults.filter((r) => r.usedVideo).length,
          },
          results: out.results,
          publish: publishResults.length ? { results: publishResults } : undefined,
          videoStatus: video,
          tip:
            out.busy
              ? out.results[0]?.error
              : out.results.length === 0
                ? 'No posts need video (none queued, or all already have videoUrl). Generate week first.'
                : pushTip ||
                  out.tip ||
                  (ok
                    ? `${ok} reel(s) ready. Click Generate videos again for more (1 at a time saves RAM).`
                    : out.results[0]?.error || 'Video generation failed'),
        });
      } catch (e) {
        res.status(500).json({ error: e.message });
      }
    })();
  });

  app.post('/api/content/publish', (req, res) => {
    if (!requireAdmin(req, res)) return;
    void (async () => {
      try {
        const out = await publishQueued(Number(req.body?.limit) || 20);
        const fails = out.results.filter((r) => !r.ok);
        res.json({
          ...out,
          summary: {
            ok: out.summary?.ok ?? out.results.filter((r) => r.ok).length,
            failed: out.summary?.failed ?? fails.length,
            publisher: out.publisher,
            channelsFull: out.summary?.channelsFull || [],
          },
          tip: out.tip,
          firstError: fails[0]?.error || null,
          sampleErrors: fails.slice(0, 3).map((f) => f.error).filter(Boolean),
        });
      } catch (e) {
        res.status(500).json({ error: e.message });
      }
    })();
  });
}

module.exports = { mountContentRoutes };
