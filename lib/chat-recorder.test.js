// Contract tests for public/chat-recorder.js (session ⏺ Record, not the talk-to-John mic).
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const recSrc = fs.readFileSync(path.join(__dirname, '../public/chat-recorder.js'), 'utf8');
const html = fs.readFileSync(path.join(__dirname, '../public/index.html'), 'utf8');

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

class FakeTrack {
  constructor(kind) {
    this.kind = kind;
    this.readyState = 'live';
  }
  stop() {
    this.readyState = 'ended';
  }
  addEventListener() {}
}

class FakeStream {
  constructor(tracks) {
    this._tracks = tracks || [];
  }
  getTracks() {
    return this._tracks;
  }
  getAudioTracks() {
    return this._tracks.filter((t) => t.kind === 'audio');
  }
  getVideoTracks() {
    return this._tracks.filter((t) => t.kind === 'video');
  }
}

class FakeMediaRecorder {
  static isTypeSupported(t) {
    return (
      t === 'audio/mp4' ||
      t === 'audio/webm' ||
      t === 'video/webm' ||
      String(t).startsWith('video/webm')
    );
  }
  constructor(stream, opts) {
    this.stream = stream;
    this.mimeType = (opts && opts.mimeType) || '';
    this.state = 'inactive';
    this.ondataavailable = null;
    this.onerror = null;
    this.onstop = null;
  }
  start() {
    this.state = 'recording';
  }
  stop() {
    this.state = 'inactive';
    if (this.ondataavailable) {
      this.ondataavailable({
        data: new Blob([Buffer.alloc(2048)], { type: this.mimeType || 'audio/mp4' }),
      });
    }
    if (this.onstop) this.onstop();
  }
}

class FakeAudioContext {
  constructor() {
    this.state = 'running';
  }
  createMediaStreamDestination() {
    return { stream: new FakeStream([new FakeTrack('audio')]), connect() {} };
  }
  createMediaStreamSource() {
    return { connect() {} };
  }
  createGain() {
    return { gain: { value: 1 }, connect() {} };
  }
  async resume() {}
  close() {}
}

function loadRecorder(nav, extras = {}) {
  const context = {
    navigator: nav,
    MediaRecorder: extras.MediaRecorder || FakeMediaRecorder,
    MediaStream: extras.MediaStream || FakeStream,
    document: extras.document || undefined,
    console,
    setInterval,
    clearInterval,
    setTimeout,
    clearTimeout,
    URL: global.URL,
    Blob: global.Blob,
    AudioContext: extras.AudioContext || FakeAudioContext,
    webkitAudioContext: extras.webkitAudioContext || FakeAudioContext,
    alert: extras.alert || (() => {}),
    sessionStorage: extras.sessionStorage || {
      getItem() {
        return null;
      },
      setItem() {},
    },
  };
  context.window = context;
  context.globalThis = context;
  vm.runInNewContext(recSrc, context, { filename: 'chat-recorder.js' });
  return context;
}

function createMountDoc() {
  const btnListeners = [];
  const btn = {
    disabled: false,
    title: 'Record screen + conversation (Chrome recommended)',
    innerHTML: '⏺ Record',
    classList: { toggle() {} },
    setAttribute() {},
    addEventListener(ev, fn) {
      if (ev === 'click') btnListeners.push(fn);
    },
  };
  const bar = {
    id: 'session-record-bar',
    hidden: true,
    querySelector() {
      return null;
    },
  };
  const hint = { id: 'session-record-hint', textContent: '', style: { display: '' } };
  const time = { id: 'session-record-time', textContent: '' };
  const stop = {
    id: 'session-record-stop',
    addEventListener() {},
  };
  const byId = {
    'session-record-btn': btn,
    'session-record-bar': bar,
    'session-record-hint': hint,
    'session-record-time': time,
    'session-record-stop': stop,
  };
  const created = [];
  const doc = {
    getElementById(id) {
      return byId[id] || created.find((el) => el.id === id) || null;
    },
    querySelector() {
      return null;
    },
    createElement(tag) {
      const el = {
        tagName: tag,
        id: '',
        className: '',
        hidden: false,
        textContent: '',
        innerHTML: '',
        style: {},
        children: [],
        setAttribute(name, value) {
          this[name] = value;
        },
        addEventListener(ev, fn) {
          this['on' + ev] = fn;
        },
        appendChild(child) {
          this.children.push(child);
          return child;
        },
        querySelector(sel) {
          if (sel.charAt(0) === '#') {
            const id = sel.slice(1);
            if (this.id === id) return this;
            const nested = this.children.find((c) => c.id === id || (c.querySelector && c.querySelector(sel)));
            if (nested && nested.id === id) return nested;
            for (const c of this.children) {
              if (c.id === id) return c;
              if (c.querySelector) {
                const found = c.querySelector(sel);
                if (found) return found;
              }
            }
          }
          return null;
        },
      };
      created.push(el);
      return el;
    },
    body: {
      appendChild(el) {
        created.push(el);
        if (el && el.id) byId[el.id] = el;
        return el;
      },
    },
    head: { appendChild() {} },
  };
  return { doc, btn, btnListeners, created, byId };
}

const iphoneNavBase = {
  userAgent:
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
  platform: 'iPhone',
  maxTouchPoints: 5,
};

const desktopChromeNavBase = {
  userAgent:
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  platform: 'Win32',
  maxTouchPoints: 1,
};

const ipadOsDesktopUa = {
  userAgent:
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15',
  platform: 'MacIntel',
  maxTouchPoints: 5,
};

const macSafariNav = {
  userAgent:
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15',
  platform: 'MacIntel',
  maxTouchPoints: 0,
};

async function main() {
  assert(recSrc.includes('Control Center'), 'iOS primary path must guide Control Center Screen Recording');
  assert(recSrc.includes('Screen Recording'), 'must name iOS Screen Recording');
  assert(
    recSrc.includes('not John’s answers') || recSrc.includes("not John's answers"),
    'mic-only must be labeled as not including John’s answers'
  );
  assert(recSrc.includes('Settings → Safari'), 'mic-denied message must mention Settings → Safari');
  assert(recSrc.includes('getDisplayMedia'), 'desktop path must still use getDisplayMedia');
  assert(recSrc.includes('preferCurrentTab: true'), 'desktop Chrome tab-share hints must stay');
  assert(recSrc.includes('Also share tab audio'), 'desktop first-time tip must stay');
  assert(
    !/webkitSpeechRecognition|new\s+SpeechRecognition|recognition\.(start|continuous)/.test(recSrc),
    'must not wire the talk-to-John mic / SpeechRecognition path'
  );
  assert(html.includes('id="session-record-btn"'), 'Record control lives on #session-record-btn');
  assert(
    /iPad\|iPhone\|iPod/i.test(html) && html.includes("platform === 'MacIntel'") && html.includes('maxTouchPoints > 1'),
    'index.html isIOSDevice pattern must remain for the recorder to match'
  );
  assert(recSrc.includes('/iPad|iPhone|iPod/i'), 'recorder must use the same iOS UA pattern');
  assert(recSrc.includes("platform === 'MacIntel'") && recSrc.includes('maxTouchPoints > 1'), 'recorder must detect iPadOS desktop UA');
  assert(recSrc.includes('shouldEnableRecordButton'), 'iOS must keep Record enabled without getDisplayMedia');
  assert(recSrc.includes('audio/mp4') && recSrc.includes('audio/aac') && recSrc.includes('audio/webm'), 'secondary path tries iOS audio mimes');

  const helpersCtx = loadRecorder({ ...iphoneNavBase, mediaDevices: { getUserMedia() {} } });
  const H = helpersCtx.ChatRecorderHelpers;

  assert(H.isIOSDevice(iphoneNavBase), 'iPhone UA is iOS');
  assert(H.isIOSDevice(ipadOsDesktopUa), 'iPadOS desktop UA is iOS');
  assert(!H.isIOSDevice(macSafariNav), 'macOS Safari is not iOS');
  assert(!H.isIOSDevice(desktopChromeNavBase), 'desktop Chrome is not iOS');

  assert(
    H.shouldEnableRecordButton({
      ...iphoneNavBase,
      mediaDevices: { getUserMedia() {} },
    }),
    'iPhone without getDisplayMedia still enables Record'
  );
  assert(
    !H.shouldEnableRecordButton({
      ...macSafariNav,
      mediaDevices: { getUserMedia() {} },
    }),
    'desktop Safari without getDisplayMedia stays unsupported'
  );
  assert(
    H.shouldEnableRecordButton({
      ...desktopChromeNavBase,
      mediaDevices: { getDisplayMedia() {}, getUserMedia() {} },
    }),
    'desktop Chrome with getDisplayMedia enables Record'
  );

  assert(H.idleRecordButtonTitle(true) === 'Record session (iPhone)', 'iOS idle title');
  assert(
    H.idleRecordButtonTitle(false) === 'Record screen + conversation (Chrome recommended)',
    'desktop idle title stays Chrome wording'
  );
  assert(H.micDeniedMessage().includes('Settings → Safari'), 'denied copy names Settings → Safari');
  assert(H.micDeniedMessage().includes('Chrome'), 'denied copy also names Chrome');

  assert(H.pickAudioMimeType((t) => t === 'audio/mp4') === 'audio/mp4', 'prefer audio/mp4');
  assert(H.pickAudioMimeType((t) => t === 'audio/aac') === 'audio/aac', 'then audio/aac');
  assert(H.pickAudioMimeType((t) => t === 'audio/webm') === 'audio/webm', 'then audio/webm');
  assert(H.pickAudioMimeType(() => false) === '', 'empty when no audio mime is supported');
  assert(H.extensionForBlobType('video/webm') === 'webm', 'desktop webm extension unchanged');
  assert(H.extensionForBlobType('video/mp4') === 'mp4', 'desktop mp4 extension unchanged');
  assert(H.extensionForBlobType('audio/mp4') === 'm4a', 'iOS audio/mp4 downloads as m4a');

  const iphoneNoDisplay = loadRecorder({
    ...iphoneNavBase,
    mediaDevices: {
      getUserMedia: async () => new FakeStream([new FakeTrack('audio')]),
    },
  });
  const iphoneRec = new iphoneNoDisplay.ChatSessionRecorder();
  assert(iphoneRec.isSupported === false, 'iPhone without getDisplayMedia is not the desktop capture path');
  assert(
    iphoneNoDisplay.ChatRecorderHelpers.shouldEnableRecordButton(iphoneNoDisplay.navigator),
    'but the Record button stays enabled'
  );

  let startRejected = false;
  try {
    await iphoneRec.start({ includeMic: true });
  } catch (e) {
    startRejected = /Chrome or Edge on desktop/.test(e.message);
  }
  assert(startRejected, 'iPhone must not pretend start() is getDisplayMedia');

  const micRec = new iphoneNoDisplay.ChatSessionRecorder();
  await micRec.startMicOnly();
  assert(micRec.isRecording, 'secondary mic-only can start on iPhone');
  assert(micRec.isAudioOnly, 'secondary path is audio-only');
  micRec.cancel();

  const deniedCtx = loadRecorder({
    ...iphoneNavBase,
    mediaDevices: {
      getUserMedia: async () => {
        const err = new Error('denied');
        err.name = 'NotAllowedError';
        throw err;
      },
    },
  });
  const deniedRec = new deniedCtx.ChatSessionRecorder();
  let deniedMsg = '';
  try {
    await deniedRec.startMicOnly();
  } catch (e) {
    deniedMsg = e.message;
  }
  assert(/Settings → Safari/.test(deniedMsg), 'mic deny must not silently no-op');

  let displayCalled = false;
  let gumCalled = false;
  const desktopCtx = loadRecorder({
    ...desktopChromeNavBase,
    mediaDevices: {
      getDisplayMedia: async () => {
        displayCalled = true;
        return new FakeStream([new FakeTrack('video'), new FakeTrack('audio')]);
      },
      getUserMedia: async () => {
        gumCalled = true;
        return new FakeStream([new FakeTrack('audio')]);
      },
    },
  });
  const desktopRec = new desktopCtx.ChatSessionRecorder();
  assert(desktopRec.isSupported, 'desktop Chrome isSupported');
  await desktopRec.start({ includeMic: true });
  assert(displayCalled, 'desktop start must call getDisplayMedia');
  assert(gumCalled, 'desktop start still requests mic for questions');
  assert(desktopRec.isRecording, 'desktop recording starts');
  assert(!desktopRec.isAudioOnly, 'desktop path is not mic-only');
  desktopRec.cancel();

  const mount = createMountDoc();
  const iosMount = loadRecorder(
    {
      ...iphoneNavBase,
      mediaDevices: { getUserMedia: async () => new FakeStream([new FakeTrack('audio')]) },
    },
    { document: mount.doc }
  );
  iosMount.mountChatRecorderUI({ button: mount.btn, statusEl: mount.byId['session-record-hint'] });
  assert(mount.btn.disabled === false, 'mount must not disable #session-record-btn on iPhone');
  assert(mount.btn.title === 'Record session (iPhone)', 'iOS mount sets iPhone title, not Chrome-only wording');
  assert(mount.btnListeners.length > 0, 'Record click is wired');
  mount.btnListeners[0]({ preventDefault() {} });
  const guide = mount.doc.getElementById('session-record-ios-guide');
  assert(guide && guide.hidden === false, 'iPhone Record tap shows the Control Center guide');
  assert(
    String(guide.innerHTML).includes('Control Center') && String(guide.innerHTML).includes('Screen Recording'),
    'guide teaches Control Center Screen Recording'
  );
  assert(
    String(guide.innerHTML).includes('not John’s answers') || String(guide.innerHTML).includes("not John's answers"),
    'secondary control is clearly not full Q & A'
  );

  console.log('chat-recorder.test.js: ok');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
