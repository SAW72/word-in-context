'use strict';
const assert = require('assert');
const {
  CACHE_ONE_YEAR,
  CACHE_MARKETING_HTML,
  CACHE_PRIVATE,
  CACHE_SW,
  cacheControlForPath,
} = require('./http-cache');

function assertEq(actual, expected, msg) {
  assert.strictEqual(actual, expected, msg || `${actual} !== ${expected}`);
}

assertEq(cacheControlForPath('/', { isProduction: true }), CACHE_MARKETING_HTML, 'homepage is public marketing');
assertEq(cacheControlForPath('/read', { isProduction: true }), CACHE_MARKETING_HTML, '/read is public marketing');
assertEq(cacheControlForPath('/privacy', { isProduction: true }), CACHE_MARKETING_HTML);
assertEq(cacheControlForPath('/terms', { isProduction: true }), CACHE_MARKETING_HTML);
assertEq(cacheControlForPath('/instructions.html', { isProduction: true }), CACHE_MARKETING_HTML);
assertEq(cacheControlForPath('/attributions.html', { isProduction: true }), CACHE_MARKETING_HTML);
assertEq(cacheControlForPath('/sitemap.xml', { isProduction: true }), CACHE_MARKETING_HTML);
assertEq(cacheControlForPath('/public/landing.html', { isProduction: true }), CACHE_MARKETING_HTML);

assertEq(cacheControlForPath('/app', { isProduction: true }), CACHE_PRIVATE, '/app stays private');
assertEq(cacheControlForPath('/index.html', { isProduction: true }), CACHE_PRIVATE, 'app shell stays private');
assertEq(cacheControlForPath('/admin', { isProduction: true }), CACHE_PRIVATE);
assertEq(cacheControlForPath('/api/chat', { isProduction: true }), CACHE_PRIVATE, 'API stays private');
assertEq(cacheControlForPath('/api/config', { isProduction: true }), CACHE_PRIVATE);

assertEq(cacheControlForPath('/sw.js', { isProduction: true }), CACHE_SW);
assertEq(cacheControlForPath('/pwa.css', { isProduction: true }), CACHE_ONE_YEAR);
assertEq(cacheControlForPath('/icons/icon-512.png', { isProduction: true }), CACHE_ONE_YEAR);

assertEq(cacheControlForPath('/', { isProduction: false }), CACHE_PRIVATE, 'dev marketing stays no-store');
assertEq(cacheControlForPath('/read', { isProduction: false }), CACHE_PRIVATE);

console.log('http-cache tests passed');
