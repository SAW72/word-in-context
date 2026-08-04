/**
 * Buffer GraphQL publisher (free plan OK).
 * No firstComment (paid). Hashtags in body. type=post for FB/IG.
 */

const { PUBLIC_URL } = require('./brand');
const { updatePost } = require('./queue');

const BUFFER_GQL = 'https://api.buffer.com/graphql';

async function bufferGql(query, variables) {
  const token = (process.env.BUFFER_API_KEY || '').trim();
  if (!token) throw new Error('BUFFER_API_KEY not set');

  const res = await fetch(BUFFER_GQL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify({ query, variables }),
  });
  const json = await res.json();
  if (!res.ok) {
    throw new Error(`Buffer HTTP ${res.status}: ${JSON.stringify(json).slice(0, 300)}`);
  }
  if (json.errors?.length) {
    throw new Error(json.errors.map((e) => e.message).join('; '));
  }
  if (json.data == null) throw new Error('Buffer empty response');
  return json.data;
}

async function listOrganizations() {
  const data = await bufferGql(`
    query { account { organizations { id name } } }
  `);
  return data.account?.organizations || [];
}

async function listChannelsForOrg(organizationId) {
  const data = await bufferGql(
    `
    query Channels($input: ChannelsInput!) {
      channels(input: $input) {
        id name displayName service isDisconnected
      }
    }
  `,
    { input: { organizationId } }
  );
  return (data.channels || []).map((c) => ({
    id: c.id,
    name: c.name || c.displayName || c.id,
    service: String(c.service || '').toLowerCase(),
    isDisconnected: c.isDisconnected,
  }));
}

async function listAllChannels() {
  const orgs = await listOrganizations();
  const all = [];
  for (const org of orgs) {
    try {
      all.push(...(await listChannelsForOrg(org.id)));
    } catch (e) {
      console.warn('[buffer] channels', org.id, e.message);
    }
  }
  return all;
}

function matchChannels(channels, networks) {
  const envMap = {
    facebook: (process.env.BUFFER_CHANNEL_FACEBOOK || '').trim(),
    instagram: (process.env.BUFFER_CHANNEL_INSTAGRAM || '').trim(),
    x: (process.env.BUFFER_CHANNEL_X || process.env.BUFFER_CHANNEL_TWITTER || '').trim(),
    twitter: (process.env.BUFFER_CHANNEL_X || process.env.BUFFER_CHANNEL_TWITTER || '').trim(),
    tiktok: (process.env.BUFFER_CHANNEL_TIKTOK || '').trim(),
  };
  const active = channels.filter((c) => !c.isDisconnected);
  const out = [];
  for (const net of networks) {
    const key = net === 'twitter' ? 'x' : net;
    if (envMap[key] || envMap[net]) {
      out.push({ network: key === 'twitter' ? 'x' : key, channelId: envMap[key] || envMap[net] });
      continue;
    }
    const hit = active.find((c) => {
      if (net === 'facebook') return c.service === 'facebook';
      if (net === 'instagram') return c.service === 'instagram';
      if (net === 'linkedin') return c.service === 'linkedin';
      // Buffer service id for X is "twitter"
      if (net === 'x' || net === 'twitter') return c.service === 'twitter';
      if (net === 'tiktok') return c.service === 'tiktok';
      return false;
    });
    if (hit) out.push({ network: net === 'twitter' ? 'x' : net, channelId: hit.id });
  }
  return out;
}

function ensureFutureDueAt(iso) {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return null;
  return new Date(Math.max(t, Date.now() + 20 * 60_000)).toISOString();
}

function metadataForNetwork(network) {
  const n = (network || '').toLowerCase();
  if (n === 'facebook' || n === 'fb') return { facebook: { type: 'post' } };
  if (n === 'instagram' || n === 'ig') {
    return { instagram: { type: 'post', shouldShareToFeed: true } };
  }
  // Buffer uses service "twitter" for X
  if (n === 'x' || n === 'twitter') return { twitter: {} };
  if (n === 'tiktok' || n === 'tt') return { tiktok: {} };
  return {};
}

/** Free X: 280 chars — keep a little headroom */
function fitCaptionForNetwork(text, network) {
  const n = (network || '').toLowerCase();
  const t = String(text || '').trim();
  if (n === 'x' || n === 'twitter') {
    const max = 270;
    if (t.length <= max) return t;
    const cut = t.slice(0, max - 1);
    const breakAt = Math.max(
      cut.lastIndexOf('\n'),
      cut.lastIndexOf('. '),
      cut.lastIndexOf('! '),
      cut.lastIndexOf('? ')
    );
    const body = (breakAt > 80 ? cut.slice(0, breakAt + 1) : cut).trim();
    return `${body}…`;
  }
  return t.slice(0, 2200);
}

/** Prefer live CONTENT_NETWORKS so adding x works without regenerating every post */
function resolvePublishNetworks(post) {
  try {
    const { CONTENT_BRAND } = require('./brand');
    if (CONTENT_BRAND?.networks?.length) return [...CONTENT_BRAND.networks];
  } catch {
    /* ignore */
  }
  const fromEnv = (process.env.CONTENT_NETWORKS || '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  if (fromEnv.length) return fromEnv;
  return post.networks?.length ? [...post.networks] : ['facebook', 'instagram'];
}

function resolveImageUrl(post) {
  const base = PUBLIC_URL.replace(/\/$/, '');
  if (post.imageKey) {
    return `${base}/content-media/${encodeURIComponent(post.imageKey)}`;
  }
  return post.imageUrl;
}

const CREATE_MUTATION = `
  mutation CreatePost($input: CreatePostInput!) {
    createPost(input: $input) {
      __typename
      ... on PostActionSuccess { post { id } }
      ... on InvalidInputError { message }
      ... on LimitReachedError { message }
      ... on UnauthorizedError { message }
      ... on NotFoundError { message }
      ... on UnexpectedError { message }
      ... on RestProxyError { message }
    }
  }
`;

async function createPostOnce(input) {
  try {
    const data = await bufferGql(CREATE_MUTATION, { input });
    const p = data.createPost;
    if (p?.post?.id) return { ok: true, id: p.post.id };
    if (p?.message) return { ok: false, error: `${p.__typename}: ${p.message}` };
    return { ok: false, error: JSON.stringify(p).slice(0, 200) };
  } catch (e) {
    return { ok: false, error: e.message || String(e) };
  }
}

async function createOnChannel(
  channelId,
  text,
  scheduledAt,
  imageUrl,
  network,
  videoUrl
) {
  const dueAt = ensureFutureDueAt(scheduledAt);
  const net = (network || '').toLowerCase();
  const isX = net === 'x' || net === 'twitter';
  const isTikTok = net === 'tiktok' || net === 'tt';
  const baseText = fitCaptionForNetwork(text, net);
  const metadata = metadataForNetwork(net);
  const hasVideo = Boolean(videoUrl);
  const requireMedia = net === 'instagram' || isTikTok;
  if (requireMedia && !imageUrl && !hasVideo) {
    throw new Error(
      isTikTok
        ? 'TikTok requires image/video URL (Generate videos first)'
        : 'Instagram requires image URL'
    );
  }

  const attempts = [];
  const build = (mode, opts) => {
    const useVideo = opts.withVideo && hasVideo;
    const useImage = !useVideo && opts.withImage && Boolean(imageUrl);
    if (requireMedia && !useVideo && !useImage) return null;
    const assets = [];
    if (useVideo) {
      assets.push({
        video: {
          url: videoUrl,
          metadata: { thumbnailOffset: 500 },
        },
      });
    } else if (useImage) {
      assets.push({
        image: {
          url: imageUrl,
          metadata: { altText: 'The Word in Context' },
        },
      });
    }
    const input = {
      channelId,
      text: baseText,
      mode,
      schedulingType: 'automatic',
      needsApproval: false,
      assets,
    };
    if (Object.keys(metadata).length) input.metadata = metadata;
    if (opts.due && mode === 'customScheduled') input.dueAt = opts.due;
    return input;
  };

  const push = (label, mode, opts) => {
    const input = build(mode, opts);
    if (input) attempts.push({ label, input });
  };

  if (isX) {
    push('queue+text', 'addToQueue', { withImage: false, withVideo: false });
    if (imageUrl) {
      push('queue+image', 'addToQueue', { withImage: true, withVideo: false });
    }
  } else if (isTikTok) {
    if (hasVideo) {
      push('queue+video', 'addToQueue', { withImage: false, withVideo: true });
    }
    push('queue+image', 'addToQueue', { withImage: true, withVideo: false });
  } else {
    if (hasVideo) {
      push('queue+video', 'addToQueue', { withImage: false, withVideo: true });
    }
    push('queue+image', 'addToQueue', { withImage: true, withVideo: false });
  }
  if (dueAt && attempts.length < 3) {
    if (isX) {
      push('scheduled+text', 'customScheduled', {
        withImage: false,
        withVideo: false,
        due: dueAt,
      });
    } else if (hasVideo) {
      push('scheduled+video', 'customScheduled', {
        withImage: false,
        withVideo: true,
        due: dueAt,
      });
    } else {
      push('scheduled+image', 'customScheduled', {
        withImage: true,
        withVideo: false,
        due: dueAt,
      });
    }
  }

  const errors = [];
  for (const a of attempts) {
    const r = await createPostOnce(a.input);
    if (r.ok) return r.id;
    errors.push(`${a.label}: ${r.error}`);
  }
  throw new Error(errors.slice(0, 3).join(' · '));
}

function isConfigured() {
  return Boolean((process.env.BUFFER_API_KEY || '').trim());
}

async function bufferHealth() {
  if (!isConfigured()) return { configured: false, channels: [] };
  try {
    const organizations = await listOrganizations();
    const channels = await listAllChannels();
    const fb = channels.find((c) => c.service === 'facebook' && !c.isDisconnected);
    const ig = channels.find((c) => c.service === 'instagram' && !c.isDisconnected);
    const tw = channels.find((c) => c.service === 'twitter' && !c.isDisconnected);
    const tt = channels.find((c) => c.service === 'tiktok' && !c.isDisconnected);
    let networks = ['facebook', 'instagram'];
    try {
      networks = require('./brand').CONTENT_BRAND.networks || networks;
    } catch {
      /* ignore */
    }
    return {
      configured: true,
      organizations,
      channels,
      networksWanted: networks,
      facebook: fb ? `${fb.name} (${fb.id})` : undefined,
      instagram: ig ? `${ig.name} (${ig.id})` : undefined,
      x: tw ? `${tw.name} (${tw.id})` : undefined,
      twitter: tw ? `${tw.name} (${tw.id})` : undefined,
      tiktok: tt ? `${tt.name} (${tt.id})` : undefined,
    };
  } catch (e) {
    return { configured: true, channels: [], error: e.message };
  }
}

function isChannelFullError(msg) {
  return /LimitReached|limit reached|queue is full|maximum number|free plan limit|scheduled post limit|too many scheduled/i.test(
    String(msg || '')
  );
}

function isRateLimitError(msg) {
  return /rate limit|Too many requests|RATE_LIMIT|429/i.test(String(msg || ''));
}

/**
 * Publish one post. Fills free-plan slots on channels that still have room.
 * opts.skipNetworks = Set of networks already at capacity (batch-level).
 * Already-posted networks (externalIds) are skipped.
 * Video failures fall back to image.
 */
async function publishPost(post, opts = {}) {
  if (!isConfigured()) {
    return { ok: false, publisher: 'buffer', postId: post.id, error: 'BUFFER_API_KEY not set' };
  }
  const skipNetworks = opts.skipNetworks || new Set();
  try {
    const channels = await listAllChannels();
    let networks = resolvePublishNetworks(post);
    // Prefer remaining networks if partial publish already stored them
    if (Array.isArray(post.networksRemaining) && post.networksRemaining.length) {
      networks = post.networksRemaining;
    }
    networks = networks.filter((n) => !skipNetworks.has(n));
    // Skip networks already successfully sent
    const already = post.externalIds || {};
    networks = networks.filter((n) => !already[n]);

    const targets = matchChannels(channels, networks);
    if (!targets.length) {
      if (Object.keys(already).length) {
        // Nothing left to send (all done or all skipped as full)
        if (post.id && post.id !== 'smoke') {
          updatePost(post.id, {
            status: 'scheduled',
            publisher: 'buffer',
            error: undefined,
          });
        }
        return {
          ok: true,
          publisher: 'buffer',
          postId: post.id,
          externalIds: already,
          fullNetworks: [...skipNetworks],
          detail: 'Already published to available channels (others full or done)',
        };
      }
      return {
        ok: false,
        publisher: 'buffer',
        postId: post.id,
        error:
          skipNetworks.size
            ? `Channels at free-plan limit: ${[...skipNetworks].join(', ')}. Clear Buffer queue or wait for posts to go live, then Publish again to fill remaining slots.`
            : 'No Buffer channels matched. Connect FB/IG/X, set CONTENT_NETWORKS, or BUFFER_CHANNEL_* ids.',
        fullNetworks: [...skipNetworks],
      };
    }

    const imageUrl = resolveImageUrl(post);
    const videoUrl = post.videoUrl || undefined;
    const externalIds = {};
    const errors = [];
    const fullNetworks = [];
    const ordered = [...targets].sort((a, b) =>
      a.network === 'facebook' ? -1 : b.network === 'facebook' ? 1 : 0
    );

    for (const t of ordered) {
      if (skipNetworks.has(t.network)) continue;
      const isX = t.network === 'x' || t.network === 'twitter';
      let text = (
        t.network === 'instagram'
          ? post.captionIg || post.caption
          : post.caption
      || '').trim();
      try {
        const { CONTENT_BRAND } = require('./brand');
        const site = (CONTENT_BRAND.website || CONTENT_BRAND.appUrl || '').replace(
          /\/$/,
          ''
        );
        if (site) {
          const host = site.replace(/^https?:\/\//i, '').toLowerCase();
          if (!text.toLowerCase().includes(host)) {
            text = `${text}\n\n${site}`;
          }
        }
      } catch {
        /* ignore */
      }
      const tags = (post.hashtags || []).filter(Boolean);
      if (tags.length) {
        if (isX) {
          const short = tags.slice(0, 2).join(' ');
          if (short && !text.toLowerCase().includes(tags[0].toLowerCase())) {
            text = fitCaptionForNetwork(`${text}\n\n${short}`, 'x');
          } else {
            text = fitCaptionForNetwork(text, 'x');
          }
        } else {
          const alreadyTags =
            tags.filter((h) => text.toLowerCase().includes(h.toLowerCase()))
              .length >= Math.min(2, tags.length);
          if (!alreadyTags) text = `${text}\n\n${tags.join(' ')}`;
        }
      } else if (isX) {
        text = fitCaptionForNetwork(text, 'x');
      }

      const tryChannel = async (vid) =>
        createOnChannel(
          t.channelId,
          text,
          post.scheduledAt,
          imageUrl,
          t.network,
          vid
        );

      try {
        let id;
        try {
          id = await tryChannel(videoUrl);
        } catch (vidErr) {
          // Video often fails (URL/hosting) — fall back to still image
          if (videoUrl && !isChannelFullError(vidErr.message)) {
            id = await tryChannel(undefined);
          } else {
            throw vidErr;
          }
        }
        externalIds[t.network] = id;
      } catch (e) {
        const msg = e.message || String(e);
        if (isRateLimitError(msg)) {
          return {
            ok: Object.keys(externalIds).length > 0,
            publisher: 'buffer',
            postId: post.id,
            externalIds: { ...already, ...externalIds },
            fullNetworks,
            error: msg,
            rateLimited: true,
          };
        }
        if (isChannelFullError(msg)) {
          fullNetworks.push(t.network);
          errors.push(`${t.network}: free queue full (limit ~10)`);
          continue;
        }
        errors.push(`${t.network}: ${msg}`);
      }
      await new Promise((r) => setTimeout(r, 350));
    }

    const merged = { ...already, ...externalIds };
    const intended = resolvePublishNetworks(post);
    const missing = intended.filter((n) => !merged[n]);
    const missingOpen = missing.filter(
      (n) => !fullNetworks.includes(n) && !skipNetworks.has(n)
    );

    if (!Object.keys(externalIds).length && !Object.keys(already).length) {
      if (post.id && post.id !== 'smoke') {
        updatePost(post.id, {
          status: 'failed',
          error: errors.join(' · ') || 'publish failed',
          fullNetworks: [...new Set([...(post.fullNetworks || []), ...fullNetworks])],
        });
      }
      return {
        ok: false,
        publisher: 'buffer',
        postId: post.id,
        error: errors.join(' · ') || 'publish failed',
        fullNetworks,
      };
    }

    // Partial fill: keep queued only for networks still open; remember full ones
    const allFull = missing.length > 0 && missingOpen.length === 0;
    const status = missingOpen.length > 0 ? 'queued' : 'scheduled';

    if (post.id && post.id !== 'smoke') {
      updatePost(post.id, {
        status,
        publisher: 'buffer',
        externalIds: merged,
        networksRemaining: missingOpen.length ? missingOpen : undefined,
        fullNetworks: [...new Set([...(post.fullNetworks || []), ...fullNetworks])],
        error: errors.length ? errors.join(' · ') : undefined,
        publishedAt: new Date().toISOString(),
      });
    }

    return {
      ok: true,
      publisher: 'buffer',
      postId: post.id,
      externalIds: merged,
      fullNetworks,
      detail:
        `Buffer: ${Object.keys(externalIds).join(', ') || 'none new'}` +
        (Object.keys(already).length
          ? ` (had: ${Object.keys(already).join(', ')})`
          : '') +
        (fullNetworks.length
          ? ` · full: ${fullNetworks.join(', ')}`
          : '') +
        (missingOpen.length
          ? ` · still need: ${missingOpen.join(', ')}`
          : allFull
            ? ' · other channels at free limit'
            : '') +
        (errors.length && !fullNetworks.length
          ? ` · ${errors.join(' · ')}`
          : ''),
    };
  } catch (e) {
    if (post.id && post.id !== 'smoke') {
      updatePost(post.id, { status: 'failed', error: e.message });
    }
    return {
      ok: false,
      publisher: 'buffer',
      postId: post.id,
      error: e.message,
    };
  }
}

/**
 * Fill free-plan slots (~10/channel). Stops filling a channel when Buffer
 * says full; keeps filling other channels that still have room.
 */
async function publishQueued(limit = 20) {
  const { listPosts: lp, updatePost: up } = require('./queue');
  const queued = lp({ status: 'queued', limit: 50 });
  const failed = lp({ status: 'failed', limit: 50 });
  const seen = new Set();
  const posts = [...queued, ...failed]
    .filter((p) => {
      if (seen.has(p.id)) return false;
      seen.add(p.id);
      return true;
    })
    .slice(0, limit);

  const skipNetworks = new Set();
  const results = [];
  let slotsFilled = 0;

  for (const p of posts) {
    if (p.status === 'failed') up(p.id, { status: 'queued', error: undefined });
    const r = await publishPost(p, { skipNetworks });
    results.push(r);
    for (const n of r.fullNetworks || []) skipNetworks.add(n);
    if (r.externalIds) {
      // count only newly succeeded networks is hard; count keys on success
      if (r.ok) slotsFilled += 1;
    }
    if (r.rateLimited) {
      console.warn('[content] stopping batch after Buffer rate limit');
      break;
    }
    // All known product networks full → stop burning API
    const allNets = new Set(
      posts.flatMap((x) => resolvePublishNetworks(x))
    );
    if ([...allNets].every((n) => skipNetworks.has(n))) {
      break;
    }
    await new Promise((r) => setTimeout(r, 600));
  }

  const ok = results.filter((r) => r.ok).length;
  const fail = results.filter((r) => !r.ok).length;
  const full = [...skipNetworks];
  return {
    results,
    publisher: 'buffer',
    summary: {
      ok,
      failed: fail,
      publisher: 'buffer',
      channelsFull: full,
    },
    tip:
      full.length
        ? `Filled available free-plan slots. Full channels: ${full.join(', ')} (~10 each). When some posts go live, Publish again to fill remaining.`
        : ok
          ? `Published/updated ${ok} post(s).`
          : undefined,
  };
}

module.exports = {
  isConfigured,
  bufferHealth,
  publishPost,
  publishQueued,
};
