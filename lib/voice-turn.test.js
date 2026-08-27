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

eval(extractFn('takeFirstSpeechChunk'));
eval(extractFn('cleanTextForSpeech'));
eval(extractFn('splitTextForSpeechChunks'));

function hasSpeakableSentenceDot(s) {
  return /[A-Za-z]\./.test(s);
}

const multiSpoken = cleanTextForSpeech('Matthew 19:9 is about divorce. The husband may not put away his wife.');
assert(!hasSpeakableSentenceDot(multiSpoken), 'cleaned speech must not leave a bare . a voice would read as "dot" at sentence end');
assert(!/:/.test(multiSpoken), 'verse colons must not be spoken');
assert(!/,/.test(multiSpoken), 'commas must become pauses, not the word comma');
assert(multiSpoken.includes('Matthew 19 9'), 'Matthew 19:9 should sound like Matthew 19 9');
assert(!/\b(dot|comma|colon|quote|dash)\b/i.test(multiSpoken), 'cleaner must not insert punctuation names');

const withDecimals = cleanTextForSpeech('See 1.14 and also 19.9 in that line. Then go on.');
assert(withDecimals.includes('1.14'), 'must not break 1.14');
assert(withDecimals.includes('19.9'), 'must not break 19.9');
assert(!hasSpeakableSentenceDot(withDecimals), 'sentence-end dots around decimals must still be stripped');

const rangeSpoken = cleanTextForSpeech('Read Matthew 19:3–9 and 1 Corinthians 7:10-15.');
assert(rangeSpoken.includes('19 3 to 9'), 'verse ranges stay speakable without a colon or dash');
assert(rangeSpoken.includes('7 10 to 15'), 'hyphen verse ranges become "to", not "dash"');

const firstFromClean = takeFirstSpeechChunk(multiSpoken);
assert(!hasSpeakableSentenceDot(firstFromClean), 'first chunk must also have no sentence-end dot');

const firstShort = takeFirstSpeechChunk('Matthew 19 9 is about divorce');
assert(firstShort === 'Matthew 19 9 is about divorce', 'short cleaned replies are one chunk');

const huge = ('Matthew 19:9 is about divorce and remarriage. '.repeat(80)) + 'The Greek word is porneia.';
const cleaned = cleanTextForSpeech(huge);
const first = takeFirstSpeechChunk(cleaned);
assert(!hasSpeakableSentenceDot(cleaned), 'long cleaned replies must not keep sentence-end dots');
assert(first.length > 0 && first.length <= 220, 'first chunk must be speakable immediately');
assert(cleaned.startsWith(first), 'first chunk is a prefix of the cleaned reply');
const rest = cleaned.slice(first.length).replace(/^\s+/, '');
assert(rest.length > 0, 'long replies must have remaining chunks');
const more = splitTextForSpeechChunks(rest);
assert(more.length > 0, 'rest of a long reply still chunks after the first utterance starts');
assert(more.every((c) => !hasSpeakableSentenceDot(c)), 'queued chunks must not keep a bare sentence-end dot');

const sw = fs.readFileSync(path.join(__dirname, '../public/sw.js'), 'utf8');
assert(sw.includes("CACHE_VERSION = 'wic-pwa-65'"), 'service worker cache must bump so production drops a stale shell');

console.log('voice-turn.test.js: ok');
