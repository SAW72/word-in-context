/**
 * Brand pack must not pitch trials or app-ad pillars.
 * Run: node content/brand.test.js
 */
const { CONTENT_BRAND } = require('./brand');

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

const pack = JSON.stringify(CONTENT_BRAND);
assert(!/free\s*trial/i.test(pack), 'brand pack must not mention free trial');
assert(!CONTENT_BRAND.hashtags.includes('#BibleApp'), 'no #BibleApp');
assert(!CONTENT_BRAND.hashtags.includes('#ChristianLiving'), 'no #ChristianLiving');
assert(
  CONTENT_BRAND.hashtags.includes('#TheWordInContext'),
  'keep #TheWordInContext'
);

const pillarIds = CONTENT_BRAND.pillars.map((p) => p.id);
assert(!pillarIds.includes('feature_cta'), 'no feature_cta pillar');
assert(!pillarIds.includes('founder_note'), 'no founder_note pillar');
assert(pillarIds.includes('word_study'), 'keep word_study');

for (const line of CONTENT_BRAND.ctaLines) {
  assert(!/free\s*trial/i.test(line), `ctaLine still has trial: ${line}`);
}

assert(
  !/soft cta to try the app/i.test(CONTENT_BRAND.voice || ''),
  'voice must not pitch the app'
);

console.log('brand.test.js: ok');
