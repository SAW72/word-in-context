// Regression tests for the live-voice commit helpers in public/index.html.
// Extracts isExplicitPauseCommand so a "second coming" question cannot stall for 60s again.
const fs = require('fs');
const path = require('path');
const html = fs.readFileSync(path.join(__dirname, '../public/index.html'), 'utf8');

function extractFn(name) {
  const re = new RegExp(`function ${name}\\([^{]+\\{`);
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

console.log('voice-turn.test.js: ok');
