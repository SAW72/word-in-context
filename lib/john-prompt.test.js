/**
 * Assert John's SYSTEM_PROMPT keeps Scripture-only interpretation,
 * the distinguish-and-cite later-tradition rule, divorce study order,
 * and the porn/harm refuse. Does not start the HTTP server.
 * Run: node lib/john-prompt.test.js
 */
const fs = require('fs');
const path = require('path');

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

const serverSrc = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
const start = serverSrc.indexOf('const SYSTEM_PROMPT = `');
const end = serverSrc.indexOf('`;', start);
assert(start >= 0 && end > start, 'SYSTEM_PROMPT template found');
const prompt = serverSrc.slice(start, end);

assert(
  !/You may name such a work only if the user asks what it is/.test(prompt),
  'old name-only-if-asked-what-it-is rule must be gone'
);

assert(
  /Distinguish-and-cite later tradition/.test(prompt),
  'distinguish-and-cite-tradition rule heading present'
);
assert(
  /Name 2–4 well-known extra-biblical rules/.test(prompt),
  'must require naming 2–4 later rules when asked'
);
assert(
  /Do not invent a fake origin/.test(prompt),
  'must refuse invented later origins'
);
assert(
  /The Word does not teach those man-made traditions or rules/.test(prompt),
  'must state later rules are not The Word'
);
assert(
  /Scripture interprets Scripture/.test(prompt),
  'Scripture still interprets Scripture'
);
assert(
  /Do not use Josephus, Philo, church fathers, the Talmud, canon law, or later books as a frame for interpreting Scripture/.test(prompt),
  'later writings must not interpret The Word'
);

assert(/Matthew 19:9/.test(prompt), 'divorce primary witness Matt 19:9 kept');
assert(/1 Corinthians 7:10–15/.test(prompt), 'divorce primary witness 1 Cor 7 kept');
assert(/Matthew 5:32/.test(prompt), 'divorce witness Matt 5:32 kept');
assert(/Mark 10:11–12/.test(prompt), 'divorce witness Mark 10 kept');
assert(/Luke 16:18/.test(prompt), 'divorce witness Luke 16 kept');
assert(/Deuteronomy 24/.test(prompt), 'divorce extra-biblical section still names Deut 24');

assert(/Refuse pornography, erotica/.test(prompt), 'porn refuse kept');
assert(/Refuse requests for instructions to harm/.test(prompt), 'harm refuse kept');

assert(
  /landingTeaserRemaining/.test(serverSrc) && /consumeLandingTeaser/.test(serverSrc),
  'landing teaser helpers still present'
);

console.log('lib/john-prompt.test.js: all assertions passed');
