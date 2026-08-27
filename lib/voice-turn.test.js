// Regression tests for the live-voice commit helpers in public/index.html.
// Extracts isExplicitPauseCommand so a "second coming" question cannot stall for 60s again.
const fs = require('fs');
const path = require('path');
const html = fs.readFileSync(path.join(__dirname, '../public/index.html'), 'utf8');

function extractFn(name) {
  const re = new RegExp(`(?:async\\s+)?function ${name}\\([^{]+\\{`);
  const start = html.search(re);
  if (start < 0) throw new Error('missing ' + name);
  let i = html.indexOf('{', start);
  let depth = 0;
  for (; i < html.length; i++) {
    if (html[i] === '{') depth++;
    else if (html[i] === '}') {
      depth--;
      if (depth === 0) return html.slice(start, i + 1);
    }
  }
  throw new Error('unclosed ' + name);
}

eval(extractFn('isExplicitPauseCommand'));

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

for (const s of ['pause', 'hold', 'wait', 'one sec', 'one second', 'hold on', 'please pause', 'pause please']) {
  assert(isExplicitPauseCommand(s), 'should treat as pause: ' + s);
}

for (const s of [
  'second coming',
  'tell me about the second chapter',
  'wait on the Lord',
  'behold the lamb',
  'section 1',
  'persecute',
  'John 1:14',
  'what does the second verse say'
]) {
  assert(!isExplicitPauseCommand(s), 'must not treat as pause: ' + s);
}

const popup = fs.readFileSync(path.join(__dirname, '../public/john-popup.js'), 'utf8');
assert(popup.includes('rec._pendingTranscript'), 'popup must keep pending transcript');
assert(popup.includes('if (wasListening && leftover) submit(leftover)'), 'popup onend must submit leftover');
assert(html.includes('tapToTalkTurn'), 'main chat must track explicit mic taps');
assert(html.includes('consumeAndSendVoice'), 'main chat must send leftover voice like Send');
assert(html.includes('recognition.continuous = !!(handsFreeEnabled && !tapToTalkTurn)'), 'tap-to-talk must be non-continuous');
assert(!html.includes('/pause|hold|wait|longer|thinking|breath|one sec|sec/'), 'old substring pause regex must be gone');

// Contract: a completed interim transcript with no isFinal must still send on onend.
function flushOnEnd({ leftover, tapToTalkTurn, isAwaitingResponse, alreadySent }) {
  if (alreadySent || isAwaitingResponse) return null;
  if (tapToTalkTurn && leftover && leftover.trim().length > 1) return leftover.trim();
  return null;
}
assert(flushOnEnd({ leftover: 'tell me about John 1:14', tapToTalkTurn: true, isAwaitingResponse: false, alreadySent: false }) === 'tell me about John 1:14', 'onend must send leftover tap-to-talk text');
assert(flushOnEnd({ leftover: 'tell me about John 1:14', tapToTalkTurn: true, isAwaitingResponse: true, alreadySent: false }) === null, 'do not double-send while chat is in flight');
assert(flushOnEnd({ leftover: '', tapToTalkTurn: true, isAwaitingResponse: false, alreadySent: false }) === null, 'empty leftover does not send');

const addMsgAt = html.indexOf('const msgEl = addMessage(reply, false);');
const speakReplyAt = html.indexOf('speak(reply);', addMsgAt);
const sourcesAt = html.indexOf('attachSourcesUI(msgEl, sources, reply);', addMsgAt);
assert(addMsgAt > 0 && speakReplyAt > addMsgAt && sourcesAt > speakReplyAt, 'TTS must start as soon as the reply bubble is added, before Sources UI');
assert(html.includes('if (autoSpeakEnabled)'), 'auto-speak must not be gated on hands-free');
assert(!html.includes('const startDelay = isIOSDevice() ? 280 : 40'), 'must not wait 280ms/40ms after every reply before TTS');
assert(html.includes('Say “') && html.includes('then your question'), 'hands-free must hint to say the wake word');

const speakSrc = extractFn('speak');
assert(!/synth\.speaking \|\| synth\.pending/.test(speakSrc), 'speak() must not cancel() on sticky speaking/pending');
assert(speakSrc.includes('takeFirstSpeechChunk'), 'speak() must isolate the first chunk before splitting a long reply');
assert(speakSrc.includes('releasedLiveMic'), 'speak() must only flip the audio session when the mic is still live');

// Same interrupt rule as speak(): only our real in-flight speech, never sticky speaking/pending.
function shouldInterruptOwnSpeech({ currentUtterance, speechQueue, speechQueueIndex, hostedAudio }) {
  return !!(currentUtterance && !currentUtterance.__isUnlock)
    || (speechQueue.length > 0 && speechQueueIndex > 0 && speechQueueIndex < speechQueue.length)
    || (hostedAudio && !hostedAudio.paused);
}
assert(!shouldInterruptOwnSpeech({
  currentUtterance: null, speechQueue: [], speechQueueIndex: 0, hostedAudio: null
}), 'typed reply after Thinking must not cancel()');
assert(!shouldInterruptOwnSpeech({
  currentUtterance: { __isUnlock: true }, speechQueue: [], speechQueueIndex: 0, hostedAudio: null
}), 'unlock utterance must not count as in-flight John speech');
assert(shouldInterruptOwnSpeech({
  currentUtterance: { __isUnlock: false }, speechQueue: ['a', 'b'], speechQueueIndex: 1, hostedAudio: null
}), 'a new speak() may cancel our own remaining chunks');
assert(speakSrc.includes('currentUtterance.__isUnlock'), 'speak() must ignore the unlock utterance when deciding to cancel');

const releaseSrc = extractFn('releaseMicForSpeechOutput');
assert(/if\s*\(\s*!hadLiveMic\s*\)\s*return false/.test(releaseSrc), 'idle mic must not abort recognition at TTS start');

const sendSrc = extractFn('sendToGrok');
assert(sendSrc.includes('releaseMicrophoneHardware()'), 'mic hardware must be released during Thinking, not when the bubble paints');
assert(sendSrc.indexOf('isAwaitingResponse = true') < sendSrc.indexOf('releaseMicrophoneHardware()'), 'awaiting gate must be set before hardware release so hands-free does not restart');

const wakeSrc = extractFn('wakeSpeechEngine');
assert(!/setTimeout\(\s*\(\)\s*=>[\s\S]*synth\.cancel\(\)/.test(wakeSrc), 'unlock utterance must not be cancel()ed after 80ms');

const fallbackSrc = extractFn('fallbackToBrowserSpeech');
assert(!/synth\.cancel\(\)/.test(fallbackSrc), 'fallback must not cancel() before the first chunk');
assert(fallbackSrc.includes('speakNextInQueue'), 'first chunk must be handed to the engine before the rest is split');
assert(/splitTextForSpeechChunks\(rest\)/.test(fallbackSrc), 'remaining chunks must be queued after the first utterance starts');

const cleanSrc = extractFn('cleanTextForSpeech');
assert(!/setTimeout|requestAnimationFrame/.test(cleanSrc), 'spoken-text cleanup must not add TTS start lag');

eval(extractFn('voiceSpeaksPunctuationNames'));
eval(extractFn('cleanTextForSpeech'));
eval(extractFn('splitSentencesForSpeech'));
eval(extractFn('wrapOversizedSpeechSentence'));
eval(extractFn('splitTextForSpeechChunks'));
eval(extractFn('takeFirstSpeechChunk'));

assert(!voiceSpeaksPunctuationNames(null), 'default / unset voice keeps punctuation');
assert(!voiceSpeaksPunctuationNames({ name: 'Google US English', voiceURI: 'Google US English' }), 'Chrome default keeps punctuation');
assert(!voiceSpeaksPunctuationNames({ name: 'Samantha', voiceURI: 'com.apple.voice.compact.en-US.Samantha' }), 'Apple default keeps punctuation');
assert(voiceSpeaksPunctuationNames({ name: 'en_US-lessac-medium (Piper Neural)', voiceURI: 'piper' }), 'Piper is known to say dot');

const multiSpoken = cleanTextForSpeech('Matthew 19:9 is about divorce. The husband may not put away his wife.');
assert(/divorce\./.test(multiSpoken), 'default voices keep sentence periods for natural pauses');
assert(/wife\./.test(multiSpoken), 'final sentence period stays for default voices');
assert(!/:/.test(multiSpoken), 'verse colons must not be spoken');
assert(multiSpoken.includes('Matthew 19 9'), 'Matthew 19:9 should sound like Matthew 19 9');
assert(!/\b(dot|comma|colon|quote|dash)\b/i.test(multiSpoken), 'cleaner must not insert punctuation names');

const withComma = cleanTextForSpeech('Hello, world. Next sentence.');
assert(withComma.includes('Hello, world.'), 'default voices keep commas and periods');

const piperSpoken = cleanTextForSpeech(
  'Matthew 19:9 is about divorce. The husband may not.',
  { name: 'en_US-lessac-medium (Piper Neural)', voiceURI: 'piper' }
);
assert(!/[A-Za-z]\./.test(piperSpoken), 'known-dot voices strip sentence periods so they do not say "dot"');
assert(piperSpoken.includes('Matthew 19 9'), 'Piper path still speaks verse refs without colon');

const withDecimals = cleanTextForSpeech('See 1.14 and also 19.9 in that line. Then go on.');
assert(withDecimals.includes('1.14'), 'must not break 1.14');
assert(withDecimals.includes('19.9'), 'must not break 19.9');
assert(/line\./.test(withDecimals), 'sentence period after a decimal stays for default voices');

const rangeSpoken = cleanTextForSpeech('Read Matthew 19:3–9 and 1 Corinthians 7:10-15.');
assert(rangeSpoken.includes('19 3 to 9'), 'verse ranges stay speakable without a colon or dash');
assert(rangeSpoken.includes('7 10 to 15'), 'hyphen verse ranges become "to", not "dash"');

const firstFromClean = takeFirstSpeechChunk(multiSpoken);
assert(firstFromClean === 'Matthew 19 9 is about divorce.', 'first chunk is the first sentence, not a 220-char mid-thought cut');
assert(!firstFromClean.includes('husband'), 'do not start speaking the second sentence in the first chunk');

const firstShort = takeFirstSpeechChunk('Matthew 19 9 is about divorce.');
assert(firstShort === 'Matthew 19 9 is about divorce.', 'a single sentence is one chunk');

const huge = ('Matthew 19:9 is about divorce and remarriage. ').repeat(80) + 'The Greek word is porneia.';
const cleaned = cleanTextForSpeech(huge);
const first = takeFirstSpeechChunk(cleaned);
assert(first === 'Matthew 19 9 is about divorce and remarriage.', 'long replies still start with the first sentence');
assert(cleaned.startsWith(first), 'first chunk is a prefix of the cleaned reply');
const rest = cleaned.slice(first.length).replace(/^\s+/, '');
assert(rest.length > 0, 'long replies must have remaining chunks');
const more = splitTextForSpeechChunks(rest);
assert(more.length > 1, 'remaining text is queued sentence by sentence');
assert(more[0] === 'Matthew 19 9 is about divorce and remarriage.', 'each queued chunk is a full sentence');
assert(more[more.length - 1] === 'The Greek word is porneia.', 'last chunk is the last sentence');

const sw = fs.readFileSync(path.join(__dirname, '../public/sw.js'), 'utf8');
assert(sw.includes("CACHE_VERSION = 'wic-pwa-65'"), 'service worker cache must bump so production drops a stale shell');

console.log('voice-turn.test.js: ok');
