'use strict';

// Header only. Does not change status, body, or routing.
const NOINDEX = 'noindex';
const NOINDEX_NOFOLLOW = 'noindex, nofollow';

function canonicalSeoPath(pathname) {
  let p = String(pathname || '/');
  const query = p.indexOf('?');
  if (query !== -1) p = p.slice(0, query);
  const hash = p.indexOf('#');
  if (hash !== -1) p = p.slice(0, hash);
  p = p.toLowerCase();
  if (!p.startsWith('/')) p = '/' + p;
  // Express keeps duplicate slashes in req.path. Collapse them so the tag
  // follows the path a crawler requested, including /api//health and //admin.
  p = p.replace(/\/{2,}/g, '/');
  return p;
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
  NOINDEX,
  NOINDEX_NOFOLLOW,
};
