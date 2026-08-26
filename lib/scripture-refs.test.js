const {
  extractRefs,
  parseReference,
  resolveBookCode,
  extraGreekEditionIds,
  isWordStudyFollowUp,
  getBlockedContentReason,
  extractThematicRefs,
  isDivorceRemarriageTopic,
  selectStudyOrderRefs,
  DIVORCE_PRIMARY_WITNESSES,
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

// Voice / spoken Matthew 19:9 (colon, alias, space, number-words)
same(extractRefs('Matthew 19:9'), ['Matthew 19:9'], 'Matthew 19:9');
same(extractRefs('Matt 19:9'), ['Matthew 19:9'], 'Matt 19:9');
same(extractRefs('mathew 19:9'), ['Matthew 19:9'], 'mathew 19:9 typo');
same(extractRefs('Matthew 19 9'), ['Matthew 19:9'], 'Matthew 19 9');
same(extractRefs('Matthew nineteen nine'), ['Matthew 19:9'], 'Matthew nineteen nine');
same(extractRefs('1 Corinthians 7:15'), ['1 Corinthians 7:15'], '1 Corinthians 7:15');
same(extractRefs('1 Cor 7:15'), ['1 Corinthians 7:15'], '1 Cor 7:15');
same(extractRefs('1CO 7:15'), ['1 Corinthians 7:15'], '1CO 7:15');

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
const matSpoken = parseReference('Matthew nineteen nine');
assert(matSpoken && matSpoken.bookCode === 'MAT' && matSpoken.chapter === 19 && matSpoken.verseStart === 9 && !matSpoken.wholeChapter, 'parse Matthew nineteen nine');
const matSpace = parseReference('Matthew 19 9');
assert(matSpace && matSpace.bookCode === 'MAT' && matSpace.chapter === 19 && matSpace.verseStart === 9, 'parse Matthew 19 9');
assert(resolveBookCode('1 cor') === '1CO', '1 cor code');
assert(resolveBookCode('1co') === '1CO', '1co code');
assert(resolveBookCode('mathew') === 'MAT', 'mathew typo code');
assert(resolveBookCode('chapter') === null, 'skip chapter as book');
const cor715 = parseReference('1 Corinthians 7:15');
assert(cor715 && cor715.bookCode === '1CO' && cor715.chapter === 7 && cor715.verseStart === 15, 'parse 1 Corinthians 7:15');

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

// Divorce / adultery / remarriage study order — primaries must be fetched
const divorceQ = 'If a spouse commits adultery and they divorce, is the innocent party free to remarry?';
assert(isDivorceRemarriageTopic(divorceQ), 'divorce+adultery+remarry is topical');
const thematicDivorce = extractThematicRefs(divorceQ);
assert(thematicDivorce.includes('Matthew 19:9'), 'thematic includes Matt 19:9');
assert(thematicDivorce.includes('1 Corinthians 7:15'), 'thematic includes 1 Cor 7:15');
assert(thematicDivorce.includes('Matthew 5:27'), 'thematic still includes Matt 5:27');
assert(thematicDivorce.indexOf('Matthew 19:9') < thematicDivorce.indexOf('Matthew 5:27'),
  'Matt 19:9 precedes Matt 5:27 in thematic study order');
assert(thematicDivorce.indexOf('1 Corinthians 7:15') < thematicDivorce.indexOf('Matthew 5:27'),
  '1 Cor 7:15 precedes Matt 5:27 in thematic study order');

const divorceStudy = selectStudyOrderRefs(divorceQ);
same(DIVORCE_PRIMARY_WITNESSES, ['Matthew 19:9', '1 Corinthians 7:15'], 'primary witness pair');
assert(divorceStudy.fetchRefs.includes('Matthew 19:9'), 'divorce fetch includes Matt 19:9');
assert(divorceStudy.fetchRefs.includes('1 Corinthians 7:15'), 'divorce fetch includes 1 Cor 7:15');
assert(divorceStudy.fetchRefs.indexOf('Matthew 19:9') < 2, 'Matt 19:9 is in the first fetch slots');
assert(divorceStudy.fetchRefs.indexOf('1 Corinthians 7:15') < 3, '1 Cor 7:15 is in the first fetch slots');

const adulteryOnly = selectStudyOrderRefs('What does the Bible say about adultery?');
assert(adulteryOnly.fetchRefs.includes('Matthew 19:9'), 'adultery fetch includes Matt 19:9');
assert(adulteryOnly.fetchRefs.includes('1 Corinthians 7:15'), 'adultery fetch includes 1 Cor 7:15');

const namedMatt = selectStudyOrderRefs('Matthew 19:9');
assert(namedMatt.fetchRefs.includes('Matthew 19:9'), 'named Matt 19:9 is fetched');
assert(namedMatt.fetchRefs.includes('1 Corinthians 7:15'), 'named Matt 19:9 also fetches 1 Cor 7:15');

const namedMathew = selectStudyOrderRefs('what about mathew 19:9');
same(namedMathew.namedRefs, ['Matthew 19:9'], 'mathew typo named');
assert(namedMathew.fetchRefs.includes('Matthew 19:9'), 'mathew 19:9 is fetched');
assert(namedMathew.fetchRefs.includes('1 Corinthians 7:15'), 'mathew 19:9 also fetches 1 Cor 7:15');

const namedCor = selectStudyOrderRefs('1 Corinthians 7:15');
assert(namedCor.fetchRefs.includes('1 Corinthians 7:15'), 'named 1 Cor 7:15 is fetched');
assert(namedCor.fetchRefs.includes('Matthew 19:9'), 'named 1 Cor 7:15 also fetches Matt 19:9');
assert(namedCor.namedRefs[0] === '1 Corinthians 7:15', '1CO alias displays as 1 Corinthians');

const namedPlusTopic = selectStudyOrderRefs('Matthew 19:9 — may the innocent spouse remarry after adultery and divorce?');
assert(namedPlusTopic.fetchRefs[0] === 'Matthew 19:9', 'named ref stays first, not buried by thematic');
assert(namedPlusTopic.fetchRefs.includes('1 Corinthians 7:15'), 'named+topic still fetches 1 Cor 7:15');

const paulLast = selectStudyOrderRefs('what about 1 Corinthians 15:8');
assert(paulLast.fetchRefs.includes('1 Corinthians 15:5-10'), 'Paul-last expand still works');
assert(!paulLast.fetchRefs.includes('Matthew 19:9'), 'Paul-last does not pin divorce verses');

console.log('lib/scripture-refs.test.js: all assertions passed');
