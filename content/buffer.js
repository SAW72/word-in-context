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

async function createOnChannel(channelId, text, scheduledAt, imageUrl, network) {
  const dueAt = ensureFutureDueAt(scheduledAt);
  const net = (network || '').toLowerCase();
  const isX = net === 'x' || net === 'twitter';
  const isTikTok = net === 'tiktok' || net === 'tt';
  const baseText = fitCaptionForNetwork(text, net);
  const metadata = metadataForNetwork(net);
  const requireImage = net === 'instagram' || isTikTok;
  if (requireImage && !imageUrl) {
    throw new Error(
      isTikTok ? 'TikTok requires image/video URL' : 'Instagram requires image URL'
    );
  }

  const attempts = [];
  const build = (mode, withImage, due) => {
    const useImage = withImage && imageUrl;
    if (requireImage && !useImage) return null;
    const input = {
      channelId,
      text: baseText,
      mode,
      schedulingType: 'automatic',
      needsApproval: false,
      assets: useImage
        ? [
            {
              image: {
                url: imageUrl,
                metadata: { altText: 'The Word in Context' },
              },
            },
          ]
        : [],
    };
    if (Object.keys(metadata).length) input.metadata = metadata;
    if (due && mode === 'customScheduled') input.dueAt = due;
    return input;
  };

  const push = (label, mode, withImage, due) => {
    const input = build(mode, withImage, due);
    if (input) attempts.push({ label, input });
  };

  // X: text-first (280 char), then optional image
  if (isX) {
    push('queue+text', 'addToQueue', false);
    if (dueAt) push('scheduled+text', 'customScheduled', false, dueAt);
    push('queue+image', 'addToQueue', true);
    push('shareNext+text', 'shareNext', false);
  } else if (isTikTok) {
    push('queue+image', 'addToQueue', true);
    if (dueAt) push('scheduled+image', 'customScheduled', true, dueAt);
    push('shareNext+image', 'shareNext', true);
  } else {
    push('queue+image', 'addToQueue', true);
    if (dueAt) push('scheduled+image', 'customScheduled', true, dueAt);
    if (!requireImage) push('queue+text', 'addToQueue', false);
    push('shareNext+image', 'shareNext', true);
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

async function publishPost(post) {
  if (!isConfigured()) {
    return { ok: false, publisher: 'buffer', postId: post.id, error: 'BUFFER_API_KEY not set' };
  }
  try {
    const channels = await listAllChannels();
    const networks = resolvePublishNetworks(post);
    const targets = matchChannels(channels, networks);
    if (!targets.length) {
      return {
        ok: false,
        publisher: 'buffer',
        postId: post.id,
        error:
          'No Buffer channels matched. Connect FB/IG/X in Buffer, set CONTENT_NETWORKS=facebook,instagram,x, or BUFFER_CHANNEL_* ids.',
        detail: `Wanted: ${networks.join(', ')}. Found: ${channels
          .map((c) => `${c.service}:${c.name}`)
          .join(' | ')}`,
      };
    }

    const imageUrl = resolveImageUrl(post);
    const externalIds = {};
    const errors = [];
    const ordered = [...targets].sort((a, b) =>
      a.network === 'facebook' ? -1 : b.network === 'facebook' ? 1 : 0
    );

    for (const t of ordered) {
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
      // X: skip dumping all hashtags (burns the 280 budget) — keep 1–2 short ones max
      if (tags.length) {
        if (isX) {
          const short = tags.slice(0, 2).join(' ');
          if (short && !text.toLowerCase().includes(tags[0].toLowerCase())) {
            text = fitCaptionForNetwork(`${text}\n\n${short}`, 'x');
          } else {
            text = fitCaptionForNetwork(text, 'x');
          }
        } else {
          const already =
            tags.filter((h) => text.toLowerCase().includes(h.toLowerCase()))
              .length >= Math.min(2, tags.length);
          if (!already) text = `${text}\n\n${tags.join(' ')}`;
        }
      } else if (isX) {
        text = fitCaptionForNetwork(text, 'x');
      }
      try {
        const id = await createOnChannel(
          t.channelId,
          text,
          post.scheduledAt,
          imageUrl,
          t.network
        );
        externalIds[t.network] = id;
      } catch (e) {
        errors.push(`${t.network}: ${e.message}`);
      }
    }

    if (!Object.keys(externalIds).length) {
      if (post.id && post.id !== 'smoke') {
        updatePost(post.id, { status: 'failed', error: errors.join(' · ') });
      }
      return {
        ok: false,
        publisher: 'buffer',
        postId: post.id,
        error: errors.join(' · ') || 'publish failed',
      };
    }

    if (post.id && post.id !== 'smoke') {
      updatePost(post.id, {
        status: 'scheduled',
        publisher: 'buffer',
        externalIds: { ...(post.externalIds || {}), ...externalIds },
        error: undefined,
        publishedAt: new Date().toISOString(),
      });
    }
    return {
      ok: true,
      publisher: 'buffer',
      postId: post.id,
      externalIds,
      detail:
        `Buffer: ${Object.keys(externalIds).join(', ')}` +
        (errors.length ? ` (partial: ${errors.join(' · ')})` : ''),
    };
  } catch (e) {
    if (post.id && post.id !== 'smoke') {
      updatePost(post.id, { status: 'failed', error: e.message });
    }
    return { ok: false, publisher: 'buffer', postId: post.id, error: e.message };
  }
}

async function publishQueued(limit = 20) {
  const { listPosts: lp, updatePost: up } = require('./queue');
  const queued = lp({ status: 'queued', limit });
  const failed = lp({ status: 'failed', limit });
  const seen = new Set();
  const posts = [...queued, ...failed]
    .filter((p) => {
      if (seen.has(p.id)) return false;
      seen.add(p.id);
      return true;
    })
    .slice(0, limit);

  const results = [];
  for (const p of posts) {
    if (p.status === 'failed') up(p.id, { status: 'queued', error: undefined });
    results.push(await publishPost(p));
  }
  return { results, publisher: 'buffer' };
}

module.exports = {
  isConfigured,
  bufferHealth,
  publishPost,
  publishQueued,
};
