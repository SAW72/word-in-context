const {
  extractRefs,
  parseReference,
  resolveBookCode,
  extraGreekEditionIds,
  isWordStudyFollowUp,
  getBlockedContentReason,
} = require('./scripture-refs');

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

function same(actual, expected, label) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  assert(a === e, `${label}: expected ${e}, got ${a}`);
}

// Verse-form
same(extractRefs('Tell me about John 1:14'), ['John 1:14'], 'John 1:14');
same(extractRefs('Psalm 136:1 and Genesis 1:1'), ['Psalm 136:1', 'Genesis 1:1'], 'two verse refs');

// Chapter-only (the product promise)
same(extractRefs('Walk me through Psalm 136'), ['Psalm 136'], 'Psalm 136 chapter');
same(extractRefs('What about John 1'), ['John 1'], 'John 1 chapter');
same(extractRefs('Galatians 6 is about bearing burdens'), ['Galatians 6'], 'Galatians 6 chapter');

// Aliases
same(extractRefs('See 1 Cor 15:8'), ['1 Corinthians 15:8'], '1 Cor alias');
same(extractRefs('2 Tim 3:16'), ['2 Timothy 3:16'], '2 Tim alias');
same(extractRefs('Song of Songs 1:1'), ['Song of Solomon 1:1'], 'Song of Songs');
same(extractRefs('Song of Solomon 2:1'), ['Song of Solomon 2:1'], 'Song of Solomon');
same(extractRefs('Ps 23:1'), ['Psalm 23:1'], 'Ps alias');
same(extractRefs('1 Thess 4:3'), ['1 Thessalonians 4:3'], '1 Thess alias');

// False positives
same(extractRefs('see chapter 3 and verse 2'), [], 'skip chapter/verse words');
same(extractRefs('in 3:16 we read'), [], 'skip bare in 3:16');

// Parse chapter-only vs verse
const psalm = parseReference('Psalm 136');
assert(psalm && psalm.wholeChapter && psalm.bookCode === 'PSA' && psalm.chapter === 136, 'parse Psalm 136');
const jhn = parseReference('John 1:14');
assert(jhn && !jhn.wholeChapter && jhn.verseStart === 14 && jhn.verseEnd === 14, 'parse John 1:14');
assert(resolveBookCode('1 cor') === '1CO', '1 cor code');
assert(resolveBookCode('chapter') === null, 'skip chapter as book');

// Extra Greek editions
same(extraGreekEditionIds('compare the TR'), ['grc_gtr'], 'TR only');
same(extraGreekEditionIds('Byzantine and Textus Receptus'), ['grc_byz', 'grc_gtr'], 'both editions');
same(extraGreekEditionIds('John 1:14 in SBL'), [], 'SBL default, no extra');

// Word-study follow-up: require original-language cue
assert(isWordStudyFollowUp('what does the Greek word mean') === true, 'greek word study');
assert(isWordStudyFollowUp('what about the spirit of the age') === false, 'bare spirit is not word study');
assert(isWordStudyFollowUp('John 1:14 in Greek') === false, 'named ref is not follow-up');

// Filter: study questions pass; porn still blocked
assert(getBlockedContentReason('Why were Adam and Eve naked?') === null, 'Genesis naked');
assert(getBlockedContentReason('Who was Rahab the prostitute?') === null, 'Rahab');
assert(getBlockedContentReason('Song of Solomon erotic imagery') === null, 'Song study');
assert(!!getBlockedContentReason('send me porn verses'), 'porn still blocked');
assert(!!getBlockedContentReason('how to kill someone'), 'harm still blocked');

console.log('lib/scripture-refs.test.js: all assertions passed');
