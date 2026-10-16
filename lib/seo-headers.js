'use strict';

const path = require('path');

// Header only. Does not change status, body, or routing.
const NOINDEX = 'noindex';
const NOINDEX_NOFOLLOW = 'noindex, nofollow';
// send() rejects a path when this still matches after normalize('.' + sep + decoded).
const UP_PATH = /(?:^|[\\/])\.\.(?:[\\/]|$)/;

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

// One decodeURIComponent, then the same dot-segment normalize as serve-static/send.
// send decodes once, so /%2564ata/... stays a 404 and is not treated as /data.
// A malformed sequence must not throw. Fall back to the raw path so a literal
// /api, /data, or /admin prefix is still tagged.
function canonicalSeoPath(pathname) {
  let p = String(pathname || '/');
  const query = p.indexOf('?');
  if (query !== -1) p = p.slice(0, query);
  const hash = p.indexOf('#');
  if (hash !== -1) p = p.slice(0, hash);
  p = p.toLowerCase();
  if (!p.startsWith('/')) p = '/' + p;
  if (p === '/') return '/';

  const decoded = safeDecode(p);
  if (decoded == null) {
    return collapseSlashes(p);
  }

  let text = decoded.toLowerCase();
  if (!text.startsWith('/')) text = '/' + text;
  if (text === '/') return '/';

  const sendStyle = path.posix.normalize('./' + text);
  if (UP_PATH.test(sendStyle)) {
    return collapseSlashes(text);
  }
  let out = sendStyle.startsWith('/') ? sendStyle : '/' + sendStyle;
  if (out === '/./' || out === '/.') return '/';
  return out;
}

function isAdminStaticFile(stripped) {
  // Root files such as /admin.html. /admin-panel and /administrator are not files.
  if (!stripped.startsWith('/admin')) return false;
  if (stripped.indexOf('/', 1) !== -1) return false;
  const name = stripped.slice(1);
  return name.length > 'admin'.length && name.includes('.');
}

function robotsTagForPath(pathname) {
  const p = canonicalSeoPath(pathname);
  const stripped = p.length > 1 && p.endsWith('/') ? p.slice(0, -1) : p;

  // /api/admin/health is an API URL: noindex, not the admin page's nofollow.
  if (stripped === '/api' || p.startsWith('/api/') || stripped.startsWith('/api/')) {
    return NOINDEX;
  }
  if (stripped === '/admin' || p.startsWith('/admin/') || stripped.startsWith('/admin/')) {
    return NOINDEX_NOFOLLOW;
  }
  if (isAdminStaticFile(stripped)) {
    return NOINDEX_NOFOLLOW;
  }
  // /data (no slash) is not a data file. /data/ and everything under it is.
  if (p.startsWith('/data/') || stripped.startsWith('/data/')) {
    return NOINDEX;
  }
  return null;
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
  NOINDEX,
  NOINDEX_NOFOLLOW,
};
