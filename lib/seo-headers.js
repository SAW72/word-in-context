'use strict';

// Header only. Does not change status, body, or routing.
const NOINDEX = 'noindex';
const NOINDEX_NOFOLLOW = 'noindex, nofollow';
const NOINDEX_FOLLOW = 'noindex, follow';

// In-root files and routes that must stay crawlable. A dot segment that
// resolves onto one of these (for example /data/../john-popup.js) is not tagged.
// /index.html is the app shell and stays untagged as well.
const PUBLIC_EXACT = new Set([
  '/',
  '/read',
  '/privacy',
  '/terms',
  '/index.html',
  '/john-popup.js',
  '/reader.css',
  '/reader.js',
  '/reader.html',
  '/privacy.html',
  '/terms.html',
  '/robots.txt',
  '/sitemap.xml',
  '/sw.js',
  '/manifest.webmanifest',
  '/landing.html',
  '/instructions.html',
  '/attributions.html',
  '/pwa.css',
  '/pwa.js',
  '/login-verify.js',
  '/share-redirect.js',
  '/share-video.js',
  '/study-core.js',
  '/success-checkout.js',
  '/voice-picker.js',
  '/audio-engine.js',
  '/auth-api.js',
  '/bible-core.js',
  '/chat-recorder.js',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/icons/icon-maskable-512.png',
  '/icons/icon-maskable.svg',
  '/icons/icon.svg',
  '/icons/share-og.png',
  '/icons/share-og.svg',
]);

function safeDecode(pathname) {
  try {
    return decodeURIComponent(pathname);
  } catch (err) {
    return null;
  }
}

function collapseSlashes(pathname) {
  return String(pathname || '/').replace(/\/{2,}/g, '/');
}

function prepare(pathname) {
  let p = String(pathname || '/');
  const query = p.indexOf('?');
  if (query !== -1) p = p.slice(0, query);
  const hash = p.indexOf('#');
  if (hash !== -1) p = p.slice(0, hash);
  p = p.toLowerCase();
  if (!p.startsWith('/')) p = '/' + p;
  return collapseSlashes(p);
}

function finishDecoded(text) {
  let p = String(text || '').toLowerCase();
  if (!p.startsWith('/')) p = '/' + p;
  return collapseSlashes(p);
}

function stripTrail(pathname) {
  return pathname.length > 1 && pathname.endsWith('/') ? pathname.slice(0, -1) : pathname;
}

// Same result as path.posix.normalize for an absolute path, including dropping
// a leading "..". One linear scan. Paths with no "/." segment skip the scan:
// normalize would only collapse duplicate slashes, which is already done.
// This avoids path.posix.normalize, which is super-linear on a long run of
// "/.." on Node 20 (about 3 ms at a 16 KB request target).
function resolveAbsolute(input) {
  let p = collapseSlashes(input);
  if (!p.startsWith('/')) p = '/' + p;
  if (p.indexOf('/.') === -1) return { normalized: p, escaped: false };

  const trailing = p.length > 1 && p.endsWith('/');
  const out = [];
  let escaped = false;
  const n = p.length;
  let i = 0;
  while (i < n) {
    while (i < n && p.charCodeAt(i) === 47) i += 1;
    if (i >= n) break;
    let j = i;
    while (j < n && p.charCodeAt(j) !== 47) j += 1;
    const len = j - i;
    const c0 = p.charCodeAt(i);
    if (len === 1 && c0 === 46) {
      // segment "."
    } else if (len === 2 && c0 === 46 && p.charCodeAt(i + 1) === 46) {
      if (out.length) out.pop();
      else escaped = true;
    } else {
      out.push(p.slice(i, j));
    }
    i = j;
  }
  let normalized = '/' + out.join('/');
  if (trailing && out.length) normalized += '/';
  return { normalized, escaped };
}

function isAdminStaticFile(stripped) {
  // Root files such as /admin.html. /admin-panel and /administrator are not files.
  if (!stripped.startsWith('/admin')) return false;
  if (stripped.indexOf('/', 1) !== -1) return false;
  const name = stripped.slice(1);
  return name.length > 'admin'.length && name.includes('.');
}

function tagOne(pathname) {
  if (!pathname) return null;
  const stripped = stripTrail(pathname);
  if (
    stripped === '/api' ||
    pathname.startsWith('/api/') ||
    stripped.startsWith('/api/') ||
    pathname.startsWith('/api%00') ||
    pathname.startsWith('/api\0')
  ) {
    return NOINDEX;
  }
  if (
    stripped === '/admin' ||
    pathname.startsWith('/admin/') ||
    stripped.startsWith('/admin/') ||
    pathname.startsWith('/admin%00') ||
    pathname.startsWith('/admin\0') ||
    isAdminStaticFile(stripped)
  ) {
    return NOINDEX_NOFOLLOW;
  }
  // /data (no slash) is not a data file. /data/ and a NUL right after /data are.
  if (
    pathname.startsWith('/data/') ||
    stripped.startsWith('/data/') ||
    pathname.startsWith('/data%00') ||
    pathname.startsWith('/data\0')
  ) {
    return NOINDEX;
  }
  return null;
}

function stronger(a, b) {
  if (a === NOINDEX_NOFOLLOW || b === NOINDEX_NOFOLLOW) return NOINDEX_NOFOLLOW;
  return a || b || null;
}

// Every candidate is considered: the raw path (not decoded, not dot-normalized),
// the once-decoded path, and the normalized path. A zone match on any of them
// sets the tag. A malformed "%" does not throw; the raw path is still checked.
function inspectSeoPath(pathname) {
  const raw = prepare(pathname);
  const decodedText = safeDecode(raw);
  const decoded = decodedText == null ? null : finishDecoded(decodedText);
  const basis = decoded || raw;
  const resolved = resolveAbsolute(basis);
  let inRoot = resolved.escaped ? null : resolved.normalized;
  if (basis.indexOf('\0') !== -1) inRoot = null;
  return {
    raw,
    decoded,
    normalized: resolved.normalized,
    inRoot,
  };
}

function normalizeSeoPath(pathname) {
  return inspectSeoPath(pathname).normalized;
}

function canonicalSeoPath(pathname) {
  return normalizeSeoPath(pathname);
}

function robotsTagForPath(pathname) {
  const info = inspectSeoPath(pathname);
  // Exact /app only, from the raw path, so /%61pp (decoded /app, not this route)
  // and /app/anything stay untagged. Value stays exactly "noindex, follow".
  if (stripTrail(info.raw) === '/app') return NOINDEX_FOLLOW;

  const nul = info.raw.indexOf('%00') !== -1 || (info.decoded && info.decoded.indexOf('\0') !== -1);
  if (!nul && info.inRoot && PUBLIC_EXACT.has(stripTrail(info.inRoot))) return null;

  let tag = tagOne(info.raw);
  if (info.decoded) tag = stronger(tag, tagOne(info.decoded));
  tag = stronger(tag, tagOne(info.normalized));
  return tag;
}

function seoNoindexHeaders(req, res, next) {
  const tag = robotsTagForPath(req.path);
  if (!tag) return next();

  const originalSetHeader = res.setHeader;
  const originalRemoveHeader = res.removeHeader;
  const originalWriteHead = res.writeHead;

  function force() {
    originalSetHeader.call(res, 'X-Robots-Tag', tag);
  }

  // Later helmet-style setHeader, res.set, res.json, and express.static
  // setHeaders must not drop or replace this tag. Other header names pass through.
  res.setHeader = function setHeaderLocked(name) {
    if (String(name).toLowerCase() === 'x-robots-tag') {
      return originalSetHeader.call(this, 'X-Robots-Tag', tag);
    }
    return originalSetHeader.apply(this, arguments);
  };
  res.removeHeader = function removeHeaderLocked(name) {
    if (String(name).toLowerCase() === 'x-robots-tag') return;
    return originalRemoveHeader.apply(this, arguments);
  };
  res.writeHead = function writeHeadLocked() {
    force();
    return originalWriteHead.apply(this, arguments);
  };

  force();
  next();
}

module.exports = {
  seoNoindexHeaders,
  robotsTagForPath,
  canonicalSeoPath,
  normalizeSeoPath,
  NOINDEX,
  NOINDEX_NOFOLLOW,
};
