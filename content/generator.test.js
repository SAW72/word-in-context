/**
 * Content creator: every helper post starts from a live fetched original.
 * Run: node content/generator.test.js
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wic-content-'));
process.env.DATA_DIR = tmp;

const { CONTENT_BRAND } = require('./brand');
const {
  buildStudyCopy,
  buildHelperPost,
  captionHasBannedCopy,
} = require('./generator');
const { STUDY_SEEDS, getSeedById } = require('./seeds');
const { PORNEIA_LIVE_RE } = require('../lib/chat-sources');

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

const HESED_LIVE_RE = /חֶסֶד|חַסְד|חסד/;

assert(getSeedById('porneia_matt_19_9'), 'porneia seed exists');
assert(getSeedById('hesed_psalm_136'), 'hesed seed exists');

assert(
  buildStudyCopy(getSeedById('porneia_matt_19_9'), null) === null,
  'null grounding skips the post'
);
assert(
  buildStudyCopy(getSeedById('porneia_matt_19_9'), []) === null,
  'empty grounding skips the post'
);
assert(
  buildStudyCopy(getSeedById('porneia_matt_19_9'), [
    { english: { text: 'except for sexual immorality', reference: 'Matthew 19:9' }, original: { text: '' } },
  ]) === null,
  'empty original block skips the post'
);
assert(
  buildStudyCopy(getSeedById('porneia_matt_19_9'), [
    {
      english: { text: 'except for sexual immorality', reference: 'Matthew 19:9' },
      original: { text: 'λέγω δὲ ὑμῖν', translation: 'grc_sbl', reference: 'Matthew 19:9' },
    },
  ]) === null,
  'original without the live focus word skips the post'
);

const fakeOk = buildStudyCopy(getSeedById('porneia_matt_19_9'), [
  {
    english: {
      reference: 'Matthew 19:9',
      translation: 'BSB',
      text: '9. whoever divorces his wife, except for sexual immorality, and marries another woman commits adultery.',
    },
    original: {
      reference: 'Matthew 19:9',
      translation: 'grc_sbl',
      text: '9. μὴ ἐπὶ πορνείᾳ καὶ γαμήσῃ ἄλλην μοιχᾶται',
    },
  },
]);
assert(fakeOk, 'copy builds when live original is present');
assert(PORNEIA_LIVE_RE.test(fakeOk.caption), 'template quotes live πορνεία form');
assert(!/free\s*trial/i.test(fakeOk.caption), 'template has no free trial');
assert(!captionHasBannedCopy(fakeOk.caption), 'template is not brochure/ad copy');

(async () => {
  const matt = await buildHelperPost('porneia_matt_19_9');
  assert(matt, 'Matthew 19:9 helper post must be built from a live fetch');
  assert(PORNEIA_LIVE_RE.test(matt.caption), `Matthew 19:9 caption missing live πορνεία / πορνείᾳ: ${matt.caption}`);
  assert(PORNEIA_LIVE_RE.test(matt.originalWord || matt.originalText || ''), 'Matthew 19:9 stores live original word');
  assert(!/free\s*trial/i.test([matt.caption, matt.captionIg, matt.cta].join('\n')), 'Matthew 19:9 has no free trial');
  assert(!/#BibleApp/i.test((matt.hashtags || []).join(' ')), 'Matthew 19:9 has no #BibleApp');
  assert(/Read Matthew 19:9/i.test(matt.caption), 'Matthew 19:9 invites reading the passage');
  assert(
    /thewordincontext\.org/i.test(matt.caption),
    'Matthew 19:9 may end with the site'
  );

  const psalm = await buildHelperPost('hesed_psalm_136');
  assert(psalm, 'Psalm 136 helper post must be built from a live WLC fetch');
  assert(
    HESED_LIVE_RE.test(psalm.caption),
    `Psalm 136 caption missing live Hebrew חֶסֶד / WLC form: ${psalm.caption}`
  );
  assert(
    HESED_LIVE_RE.test(psalm.originalWord || psalm.originalText || ''),
    'Psalm 136 stores fetched WLC hesed form'
  );
  assert(!/free\s*trial/i.test(psalm.caption), 'Psalm 136 has no free trial');

  const skipped = await buildHelperPost({
    id: 'missing_original',
    question: 'What does this invented verse say?',
    passages: [{ ref: 'Matthew 99:1', focusRe: /πορνεί[αάᾳ]ς?/ }],
  });
  assert(skipped === null, 'failed original fetch skips the post');

  const pack = JSON.stringify(CONTENT_BRAND) + STUDY_SEEDS.map((s) => s.question).join('\n');
  assert(!/why does context matter when reading a single verse/i.test(pack), 'no brochure smoke hook in seeds/brand');
  assert(!/q: word study\?/i.test(pack), 'no brochure Word study hook');

  console.log('generator.test.js: Matt 19:9 πορνεία + Psalm 136 hesed + skip-on-fail ok');
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
