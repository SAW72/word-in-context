/**
 * Content API for The Word in Context.
 * Auth: same as other admin routes — Authorization: Bearer <admin JWT>
 */
const path = require('path');
const fs = require('fs');
const { CONTENT_BRAND, PUBLIC_URL } = require('./brand');
const { listPosts, loadQueue, requeuePostsForNetworks } = require('./queue');
const { generatePosts, buildCopyPack, countByStatus } = require('./generator');
const {
  isConfigured,
  bufferHealth,
  publishPost,
  publishQueued,
} = require('./buffer');

/**
 * @param {import('express').Application} app
 * @param {{ requireAdmin: (req: any, res: any) => boolean }} deps
 */
function mountContentRoutes(app, { requireAdmin }) {
  const mediaDirs = [
    path.join(__dirname, '..', 'public', 'icons'),
    path.join(__dirname, '..', 'public', 'content-media'),
  ];
  for (const dir of mediaDirs) {
    if (fs.existsSync(dir)) {
      const express = require('express');
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
          publicUrl: PUBLIC_URL,
          xaiConfigured: Boolean((process.env.XAI_API_KEY || '').trim()),
          tips: [
            'Separate Buffer FB/IG for The Word in Context (not IA or Trail Tracker).',
            'BUFFER_API_KEY + XAI_API_KEY on Render. SHARE_SITE_URL for image URLs.',
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

  app.post('/api/content/publish', (req, res) => {
    if (!requireAdmin(req, res)) return;
    void (async () => {
      try {
        const out = await publishQueued(Number(req.body?.limit) || 20);
        const fails = out.results.filter((r) => !r.ok);
        res.json({
          ...out,
          summary: {
            ok: out.results.filter((r) => r.ok).length,
            failed: fails.length,
            publisher: out.publisher,
          },
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
