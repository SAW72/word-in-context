const {
  normalizeFetchedSources,
  classifyGroundingLabel,
  formatGroundingBlocks,
  hasOriginalGreekBlock,
  PORNEIA_LIVE_RE,
} = require('./chat-sources');

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

function same(actual, expected, label) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  assert(a === e, `${label}: expected ${e}, got ${a}`);
}

same(normalizeFetchedSources(null), [], 'null');
same(normalizeFetchedSources(undefined), [], 'undefined');
same(normalizeFetchedSources({}), [], 'non-array object');

same(normalizeFetchedSources([
  { reference: 'John 1:14', translation: 'Berean Standard Bible', text: 'And the Word became flesh' },
  { reference: 'John 1:14', translation: 'SBL Greek New Testament', text: 'Καὶ ὁ λόγος σὰρξ ἐγένετο' },
]), [
  { reference: 'John 1:14', translation: 'Berean Standard Bible', text: 'And the Word became flesh' },
  { reference: 'John 1:14', translation: 'SBL Greek New Testament', text: 'Καὶ ὁ λόγος σὰρξ ἐγένετο' },
], 'keep fetched English + SBL');

same(normalizeFetchedSources([
  { reference: 'John 1:14', translation: 'Berean Standard Bible', text: 'And the Word became flesh' },
  { reference: 'John 1:14', translation: 'Textus Receptus Greek New Testament', text: 'και ο λογος σαρξ εγενετο' },
]), [
  { reference: 'John 1:14', translation: 'Berean Standard Bible', text: 'And the Word became flesh' },
  { reference: 'John 1:14', translation: 'Textus Receptus Greek New Testament', text: 'και ο λογος σαρξ εγενετο' },
], 'keep TR only when it was fetched');

same(normalizeFetchedSources([
  { reference: 'Psalm 136:1-26', translation: 'Berean Standard Bible', text: 'Give thanks to the LORD' },
  { reference: '', translation: 'Westminster Leningrad Codex (Hebrew OT)', text: 'הוֹדוּ' },
  { reference: 'Psalm 136:1-26', translation: '', text: 'הוֹדוּ' },
  { reference: 'Psalm 136:1-26', translation: 'Invented Edition', text: '' },
  { reference: 'John 1:14', translation: 'SBL Greek New Testament' },
]), [
  { reference: 'Psalm 136:1-26', translation: 'Berean Standard Bible', text: 'Give thanks to the LORD' },
], 'drop editions that were not actually fetched');

same(normalizeFetchedSources([
  { reference: 'John 1:14', translation: 'Berean Standard Bible', text: 'And the Word became flesh', rawId: 'BSB' },
  { reference: 'John 1:14', translation: 'Berean Standard Bible', text: 'And the Word became flesh', rawId: 'BSB' },
]), [
  { reference: 'John 1:14', translation: 'Berean Standard Bible', text: 'And the Word became flesh', rawId: 'BSB' },
], 'dedupe same ref + edition');

assert(classifyGroundingLabel('grc_sbl') === 'ORIGINAL GREEK TEXT', 'SBL is original Greek');
assert(classifyGroundingLabel('BSB') === 'ACCURATE BIBLE TEXT', 'BSB is English');
assert(classifyGroundingLabel('hbo_wlc') === 'ORIGINAL HEBREW TEXT', 'WLC is original Hebrew');

const blocks = formatGroundingBlocks([
  { reference: 'Matthew 19:9', translation: 'grc_sbl', text: 'μὴ ἐπὶ πορνείᾳ καὶ γαμήσῃ' },
  { reference: '1 Corinthians 7:15', translation: 'grc_sbl', text: 'οὐ δεδούλωται ὁ ἀδελφὸς' },
], (t) => t === 'grc_sbl' ? 'SBL Greek New Testament' : t);

assert(hasOriginalGreekBlock(blocks, 'Matthew 19:9'), 'Matt 19:9 original block present');
assert(hasOriginalGreekBlock(blocks, '1 Corinthians 7:15'), '1 Cor 7:15 original block present');
assert(PORNEIA_LIVE_RE.test(blocks), 'original block contains live porneia');
assert(blocks.includes('[ORIGINAL GREEK TEXT — Matthew 19:9'), 'Matt 19:9 original header');
assert(blocks.includes('[ORIGINAL GREEK TEXT — 1 Corinthians 7:15'), '1 Cor 7:15 original header');

console.log('chat-sources.test.js: ok');
