const { normalizeFetchedSources } = require('./chat-sources');

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

console.log('chat-sources.test.js: ok');
