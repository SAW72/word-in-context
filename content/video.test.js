/**
 * Talking-card overlay + TTS: Q + live original; study answer, not a sales line.
 * Run: node content/video.test.js
 */
const {
  overlayTextFromPost,
  voiceScriptFromPost,
  overlayHasOriginalScript,
} = require('./video-copy');

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

const post = {
  question: 'Does Matthew 19:9 allow divorce for any reason?',
  caption: [
    'Q: Does Matthew 19:9 allow divorce for any reason?',
    '',
    'A: Matthew 19:9 uses πορνείᾳ in the live SBL Greek. “μὴ ἐπὶ πορνείᾳ καὶ γαμήσῃ ἄλλην μοιχᾶται.” BSB: “except for sexual immorality.”',
    '',
    'Read Matthew 19:9 in context.',
    '',
    'https://www.thewordincontext.org',
  ].join('\n'),
  originalWord: 'πορνείᾳ',
  originalWords: ['πορνείᾳ'],
  originalText: 'λέγω δὲ ὑμῖν ὅτι ὃς ἂν ἀπολύσῃ τὴν γυναῖκα αὐτοῦ μὴ ἐπὶ πορνείᾳ καὶ γαμήσῃ ἄλλην μοιχᾶται',
  translit: 'porneia',
  translits: ['porneia'],
  englishText: 'whoever divorces his wife, except for sexual immorality',
};

const overlay = overlayTextFromPost(post);
assert(/Does Matthew 19:9/.test(overlay), 'overlay shows the study Q');
assert(overlay.includes('πορνείᾳ'), 'overlay shows live original word');
assert(overlayHasOriginalScript(overlay), 'overlay flagged as original script');
assert(!/free trial/i.test(overlay), 'overlay has no trial pitch');
assert(!/#BibleApp/i.test(overlay), 'overlay has no #BibleApp');

const spoken = voiceScriptFromPost(post);
assert(/Matthew 19:9/.test(spoken), 'TTS includes the study question');
assert(/porneia/i.test(spoken), 'TTS speaks transliteration, not a sales line');
assert(!/πορνεί/.test(spoken), 'TTS does not read raw Greek letters');
assert(!/free trial/i.test(spoken), 'TTS has no free trial');
assert(!/try the (word in context|app)/i.test(spoken), 'TTS has no try-the-app line');
assert(!/thewordincontext\.org/i.test(spoken), 'TTS does not read the URL');

const hesedPost = {
  question: 'What does Psalm 136 keep repeating with hesed?',
  caption: 'Q: What does Psalm 136 keep repeating with hesed?\n\nA: Psalm 136:1 uses חַסְדּוֹ.\n\nRead Psalm 136:1 in context.',
  originalWord: 'חַסְדּוֹ',
  originalWords: ['חַסְדּוֹ'],
  originalText: 'הוֹדוּ לַיהוָה כִּי־טוֹב כִּי לְעוֹלָם חַסְדּוֹ',
  translit: 'hesed',
  translits: ['hesed'],
};
const hesedOverlay = overlayTextFromPost(hesedPost);
assert(hesedOverlay.includes('חַסְדּוֹ') || /hesed/i.test(hesedOverlay), 'Psalm overlay shows live hesed form');
assert(/Psalm 136/.test(hesedOverlay), 'Psalm overlay shows the Q');

console.log('video.test.js: ok');
