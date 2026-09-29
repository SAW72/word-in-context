'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.join(__dirname, '..');
const bibleSrc = fs.readFileSync(path.join(root, 'public/bible-core.js'), 'utf8');
const sandbox = {
  window: {},
  localStorage: { getItem() { return null; }, setItem() {} },
  fetch: () => Promise.reject(new Error('no network in this test'))
};
vm.createContext(sandbox);
vm.runInContext(bibleSrc, sandbox);
const BC = sandbox.window.BibleCore;
assert.ok(BC && typeof BC.nextChapterLocation === 'function', 'BibleCore.nextChapterLocation is exported');

function at(code, chapter) {
  const book = BC.allBooks().find((b) => b.code === code);
  assert.ok(book, code);
  return BC.nextChapterLocation(book, chapter);
}

const gen2 = at('GEN', 1);
assert.strictEqual(gen2.book.code, 'GEN');
assert.strictEqual(gen2.chapter, 2);

const exo = at('GEN', 50);
assert.strictEqual(exo.book.code, 'EXO');
assert.strictEqual(exo.chapter, 1);

const mat = at('MAL', 4);
assert.strictEqual(mat.book.code, 'MAT');
assert.strictEqual(mat.chapter, 1);

const thirdJohn = at('2JN', 1);
assert.strictEqual(thirdJohn.book.code, '3JN');
assert.strictEqual(thirdJohn.chapter, 1);

assert.strictEqual(at('REV', 22), null);
assert.strictEqual(BC.nextChapterLocation(null, 1), null);
assert.strictEqual(BC.nextChapterLocation(at('GEN', 1).book, 0), null);

const reader = fs.readFileSync(path.join(root, 'public/reader.js'), 'utf8');
assert.ok(reader.includes('continueToNextChapter'), 'play session advances when a chapter ends');
assert.ok(reader.includes('nextChapterLocation'), 'reader uses the shared next-chapter lookup');
assert.ok(reader.includes('keepPlaying'), 'auto-advance loads the next chapter without ending the session');
assert.ok(reader.includes('audioSession'), 'play keeps a session that survives the chapter boundary');
assert.ok(!reader.includes("els.audioLabel.textContent = 'Chapter complete'"), 'end of a chapter no longer stops the player');

const engine = fs.readFileSync(path.join(root, 'public/audio-engine.js'), 'utf8');
assert.ok(engine.includes('audio.onended = null'), 'stopping audio does not fire the chapter-ended handler');
assert.ok(engine.includes('function handoffMp3'), 'next chapter audio starts inside the ended event');
assert.ok(reader.includes('handoffMp3'), 'reader hands the audio session to the next chapter');
assert.ok(reader.includes('prefetchNextChapterAudio'), 'the next chapter audio is buffered while this one plays');

console.log('reader-audio-continue.test.js: ok');
