'use strict';

const CACHE_ONE_YEAR = 'public, max-age=31536000, immutable';
const CACHE_MARKETING_HTML = 'public, max-age=300, stale-while-revalidate=3600';
const CACHE_PRIVATE = 'no-store, no-cache, must-revalidate, proxy-revalidate';
const CACHE_SW = 'no-cache, no-store, must-revalidate';

const MARKETING_URL_PATHS = new Set([
  '/',
  '/read',
  '/privacy',
  '/terms',
  '/copyright',
  '/sitemap.xml',
  '/robots.txt',
  '/landing.html',
  '/reader.html',
  '/privacy.html',
  '/terms.html',
  '/instructions.html',
  '/attributions.html',
]);

const MARKETING_HTML_NAMES = new Set([
  'landing.html',
  'reader.html',
  'privacy.html',
  'terms.html',
  'instructions.html',
  'attributions.html',
]);

const PRIVATE_HTML_NAMES = new Set(['index.html', 'admin.html']);

function basenamePath(p) {
  return String(p || '').split(/[\\/]/).pop() || '';
}

function isLongCacheStaticPath(p) {
  const s = String(p || '');
  if (s === '/sw.js' || /\/sw\.js$/i.test(s)) return false;
  if (/\.html?$/i.test(s)) return false;
  if (/\/icons\//.test(s) || /\/audio\/generated\//.test(s) || /\/data\//.test(s)) return true;
  return /\.(css|js|mjs|woff2?|png|jpe?g|gif|webp|svg|ico|mp3|webmanifest|json)$/i.test(s);
}

function isMarketingHtmlPath(p) {
  const s = String(p || '');
  if (MARKETING_URL_PATHS.has(s)) return true;
  return MARKETING_HTML_NAMES.has(basenamePath(s));
}

function isPrivateHtmlPath(p) {
  const s = String(p || '');
  if (s === '/app' || s === '/admin') return true;
  return PRIVATE_HTML_NAMES.has(basenamePath(s));
}

function cacheControlForPath(p, { isProduction = false } = {}) {
  const s = String(p || '');
  if (s === '/sw.js' || /\/sw\.js$/i.test(s)) return CACHE_SW;
  if (isProduction && isLongCacheStaticPath(s)) return CACHE_ONE_YEAR;
  if (isProduction && isMarketingHtmlPath(s) && !isPrivateHtmlPath(s)) return CACHE_MARKETING_HTML;
  return CACHE_PRIVATE;
}

function applyCacheControl(res, p, { isProduction = false } = {}) {
  const value = cacheControlForPath(p, { isProduction });
  res.set('Cache-Control', value);
  if (value === CACHE_PRIVATE || value === CACHE_SW) {
    res.set('Pragma', 'no-cache');
    res.set('Expires', '0');
  }
  return value;
}

module.exports = {
  CACHE_ONE_YEAR,
  CACHE_MARKETING_HTML,
  CACHE_PRIVATE,
  CACHE_SW,
  isLongCacheStaticPath,
  isMarketingHtmlPath,
  isPrivateHtmlPath,
  cacheControlForPath,
  applyCacheControl,
};
