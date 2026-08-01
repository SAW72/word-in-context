const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

function resolveDataDir() {
  if (process.env.DATA_DIR) return process.env.DATA_DIR;
  if (fs.existsSync('/data')) return '/data';
  return path.join(__dirname, '..', 'data');
}

function filePath() {
  return path.join(resolveDataDir(), 'content-queue.json');
}

function empty() {
  return {
    version: 1,
    updatedAt: new Date().toISOString(),
    posts: [],
    imageCursor: 0,
    pillarCursor: 0,
  };
}

function loadQueue() {
  try {
    const p = filePath();
    if (!fs.existsSync(p)) return empty();
    const data = JSON.parse(fs.readFileSync(p, 'utf8'));
    if (!data || !Array.isArray(data.posts)) return empty();
    return {
      version: 1,
      updatedAt: data.updatedAt || new Date().toISOString(),
      posts: data.posts,
      imageCursor: data.imageCursor || 0,
      pillarCursor: data.pillarCursor || 0,
    };
  } catch (err) {
    console.warn('[content] load queue failed', err.message);
    return empty();
  }
}

function saveQueue(q) {
  const dir = resolveDataDir();
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  q.updatedAt = new Date().toISOString();
  fs.writeFileSync(filePath(), JSON.stringify(q, null, 2), 'utf8');
}

function newId() {
  return crypto.randomBytes(12).toString('hex');
}

function listPosts(opts = {}) {
  let posts = loadQueue().posts;
  if (opts.status) posts = posts.filter((p) => p.status === opts.status);
  posts = [...posts].sort((a, b) =>
    (b.scheduledAt || '').localeCompare(a.scheduledAt || '')
  );
  if (opts.limit) posts = posts.slice(0, opts.limit);
  return posts;
}

function upsertPosts(posts) {
  const q = loadQueue();
  const byId = new Map(q.posts.map((p) => [p.id, p]));
  for (const p of posts) byId.set(p.id, p);
  q.posts = [...byId.values()];
  const cutoff = Date.now() - 180 * 86400000;
  q.posts = q.posts.filter((p) => {
    const t = Date.parse(p.scheduledAt || p.createdAt);
    return !Number.isFinite(t) || t >= cutoff || p.status === 'queued';
  });
  saveQueue(q);
  return q;
}

function updatePost(id, patch) {
  const q = loadQueue();
  const idx = q.posts.findIndex((p) => p.id === id);
  if (idx < 0) return null;
  q.posts[idx] = {
    ...q.posts[idx],
    ...patch,
    updatedAt: new Date().toISOString(),
  };
  saveQueue(q);
  return q.posts[idx];
}

function removePostsByIds(ids) {
  const set = new Set(ids);
  const q = loadQueue();
  q.posts = q.posts.filter((p) => !set.has(p.id));
  saveQueue(q);
}

function nextPillar(brand) {
  const q = loadQueue();
  const idx = q.pillarCursor || 0;
  const pillar = brand.pillars[idx % brand.pillars.length];
  q.pillarCursor = (idx + 1) % brand.pillars.length;
  saveQueue(q);
  return pillar;
}

function nextImage(brand) {
  const q = loadQueue();
  const idx = q.imageCursor || 0;
  const keys = brand.imageKeys || [];
  const key = keys[idx % Math.max(keys.length, 1)] || 'share-og.png';
  q.imageCursor = keys.length ? (idx + 1) % keys.length : 0;
  saveQueue(q);
  return key;
}

module.exports = {
  loadQueue,
  listPosts,
  upsertPosts,
  updatePost,
  removePostsByIds,
  nextPillar,
  nextImage,
  newId,
  resolveDataDir,
};
