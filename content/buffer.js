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
  };
  const active = channels.filter((c) => !c.isDisconnected);
  const out = [];
  for (const net of networks) {
    if (envMap[net]) {
      out.push({ network: net, channelId: envMap[net] });
      continue;
    }
    const hit = active.find((c) => {
      if (net === 'facebook') return c.service === 'facebook';
      if (net === 'instagram') return c.service === 'instagram';
      return false;
    });
    if (hit) out.push({ network: net, channelId: hit.id });
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
  if (n === 'facebook') return { facebook: { type: 'post' } };
  if (n === 'instagram') {
    return { instagram: { type: 'post', shouldShareToFeed: true } };
  }
  return {};
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
  const baseText = String(text || '').slice(0, 2200);
  const metadata = metadataForNetwork(network);
  const requireImage = network === 'instagram';
  if (requireImage && !imageUrl) throw new Error('Instagram requires image URL');

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
      metadata,
    };
    if (due && mode === 'customScheduled') input.dueAt = due;
    return input;
  };

  const push = (label, mode, withImage, due) => {
    const input = build(mode, withImage, due);
    if (input) attempts.push({ label, input });
  };

  push('queue+image', 'addToQueue', true);
  if (dueAt) push('scheduled+image', 'customScheduled', true, dueAt);
  if (!requireImage) push('queue+text', 'addToQueue', false);
  push('shareNext+image', 'shareNext', true);

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
    return {
      configured: true,
      organizations,
      channels,
      facebook: fb ? `${fb.name} (${fb.id})` : undefined,
      instagram: ig ? `${ig.name} (${ig.id})` : undefined,
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
    const targets = matchChannels(channels, post.networks || ['facebook', 'instagram']);
    if (!targets.length) {
      return {
        ok: false,
        publisher: 'buffer',
        postId: post.id,
        error: 'No FB/IG channels matched in Buffer',
        detail: channels.map((c) => `${c.service}:${c.name}`).join(' | '),
      };
    }

    const imageUrl = resolveImageUrl(post);
    const externalIds = {};
    const errors = [];
    const ordered = [...targets].sort((a, b) =>
      a.network === 'facebook' ? -1 : b.network === 'facebook' ? 1 : 0
    );

    for (const t of ordered) {
      let text = (
        t.network === 'instagram'
          ? post.captionIg || post.caption
          : post.caption
      || '').trim();
      const tags = (post.hashtags || []).filter(Boolean);
      if (tags.length) {
        const already =
          tags.filter((h) => text.toLowerCase().includes(h.toLowerCase()))
            .length >= Math.min(2, tags.length);
        if (!already) text = `${text}\n\n${tags.join(' ')}`;
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
