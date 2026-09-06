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
    return t === 'video/webm' || String(t).startsWith('video/webm');
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
        data: new Blob([Buffer.alloc(2048)], { type: this.mimeType || 'video/webm' }),
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
    hidden: false,
    title: 'Record screen + conversation (Chrome recommended)',
    innerHTML: '⏺ Record',
    style: { display: '' },
    classList: { toggle() {} },
    setAttribute(name, value) {
      this[name] = value === '' ? true : value;
    },
    removeAttribute(name) {
      if (name === 'hidden') this.hidden = false;
      else delete this[name];
    },
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
  assert(recSrc.includes('shouldEnableRecordButton'), 'must export enablement helper');
  assert(recSrc.includes('shouldHideRecordButton'), 'must export iOS hide helper');
  assert(recSrc.includes('unsupportedRecordButtonTitle'), 'must export quiet unsupported title');
  assert(
    html.includes('#session-record-btn[hidden]'),
    'CSS must hide #session-record-btn[hidden] so ID display:inline-flex cannot keep it visible'
  );
  assert(
    html.includes('html.ios #session-record-btn'),
    'CSS must hide Record on html.ios so iPhone never paints the dead control'
  );

  // iOS UX must stay quiet: no Control Center / Screen Recording guide or “sign” popup.
  assert(!recSrc.includes('session-record-ios-guide'), 'must not inject an iOS guide dialog');
  assert(!recSrc.includes('session-record-ios-card'), 'must not inject an iOS guide card');
  assert(!recSrc.includes('session-record-ios-gotit'), 'must not inject a guide dismiss button');
  assert(!recSrc.includes('startMicOnly'), 'must not offer a mic-only iPhone fallback');
  const recSrcNoComments = recSrc.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  assert(!recSrcNoComments.includes('Control Center'), 'must not teach Control Center on iPhone');
  assert(!/Screen Recording/.test(recSrcNoComments), 'must not name iOS Screen Recording in a guide');

  const helpersCtx = loadRecorder({ ...iphoneNavBase, mediaDevices: { getUserMedia() {} } });
  const H = helpersCtx.ChatRecorderHelpers;

  assert(H.isIOSDevice(iphoneNavBase), 'iPhone UA is iOS');
  assert(H.isIOSDevice(ipadOsDesktopUa), 'iPadOS desktop UA is iOS');
  assert(!H.isIOSDevice(macSafariNav), 'macOS Safari is not iOS');
  assert(!H.isIOSDevice(desktopChromeNavBase), 'desktop Chrome is not iOS');

  assert(H.shouldHideRecordButton(iphoneNavBase), 'iPhone hides Record');
  assert(H.shouldHideRecordButton(ipadOsDesktopUa), 'iPadOS desktop UA hides Record');
  assert(!H.shouldHideRecordButton(macSafariNav), 'macOS Safari does not hide Record');
  assert(!H.shouldHideRecordButton(desktopChromeNavBase), 'desktop Chrome does not hide Record');

  assert(
    !H.shouldEnableRecordButton({
      ...iphoneNavBase,
      mediaDevices: { getUserMedia() {} },
    }),
    'iPhone without getDisplayMedia disables Record'
  );
  assert(
    !H.shouldEnableRecordButton({
      ...iphoneNavBase,
      mediaDevices: { getDisplayMedia() {}, getUserMedia() {} },
    }),
    'iPhone stays disabled even if getDisplayMedia is present (cannot capture John’s voice)'
  );
  assert(
    !H.shouldEnableRecordButton({
      ...ipadOsDesktopUa,
      mediaDevices: { getUserMedia() {} },
    }),
    'iPadOS desktop UA disables Record'
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

  assert(
    H.idleRecordButtonTitle() === 'Record screen + conversation (Chrome recommended)',
    'desktop idle title stays Chrome wording'
  );
  assert(
    H.unsupportedRecordButtonTitle() === 'Recording not supported. Use Chrome on a computer.',
    'quiet unsupported title names Chrome on a computer'
  );
  assert(H.extensionForBlobType('video/webm') === 'webm', 'desktop webm extension unchanged');
  assert(H.extensionForBlobType('video/mp4') === 'mp4', 'desktop mp4 extension unchanged');

  const iphoneNoDisplay = loadRecorder({
    ...iphoneNavBase,
    mediaDevices: {
      getUserMedia: async () => new FakeStream([new FakeTrack('audio')]),
    },
  });
  const iphoneRec = new iphoneNoDisplay.ChatSessionRecorder();
  assert(iphoneRec.isSupported === false, 'iPhone without getDisplayMedia is not the desktop capture path');
  assert(
    iphoneNoDisplay.ChatRecorderHelpers.shouldEnableRecordButton(iphoneNoDisplay.navigator) === false,
    'iPhone Record button stays disabled (and is hidden at mount)'
  );

  let startRejected = false;
  try {
    await iphoneRec.start({ includeMic: true });
  } catch (e) {
    startRejected = /Chrome or Edge on desktop/.test(e.message);
  }
  assert(startRejected, 'iPhone must not pretend start() is getDisplayMedia');

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
  desktopRec.cancel();

  const iosMount = createMountDoc();
  let iosAlerted = false;
  const iosCtx = loadRecorder(
    {
      ...iphoneNavBase,
      mediaDevices: { getUserMedia: async () => new FakeStream([new FakeTrack('audio')]) },
    },
    {
      document: iosMount.doc,
      alert() {
        iosAlerted = true;
      },
    }
  );
  iosCtx.mountChatRecorderUI({ button: iosMount.btn, statusEl: iosMount.byId['session-record-hint'] });
  assert(iosMount.btn.hidden === true, 'mount hides #session-record-btn on iPhone (not just disable)');
  assert(iosMount.btn.style.display === 'none', 'iPhone Record uses display:none so ID flex cannot show it');
  assert(iosMount.btn.disabled === true, 'hidden iPhone Record stays disabled');
  assert(iosMount.btnListeners.length === 0, 'hidden iPhone Record is not click-wired');
  assert(iosAlerted === false, 'iPhone Record must not show an instructional alert/modal');
  assert(iosMount.doc.getElementById('session-record-ios-guide') == null, 'iPhone must not open a guide popup');
  assert(iosMount.created.every((el) => el.id !== 'session-record-ios-guide'), 'no iOS guide element is created');

  const ipadMount = createMountDoc();
  const ipadCtx = loadRecorder(
    {
      ...ipadOsDesktopUa,
      mediaDevices: { getUserMedia: async () => new FakeStream([new FakeTrack('audio')]) },
    },
    { document: ipadMount.doc }
  );
  ipadCtx.mountChatRecorderUI({ button: ipadMount.btn, statusEl: ipadMount.byId['session-record-hint'] });
  assert(ipadMount.btn.hidden === true, 'mount hides #session-record-btn on iPadOS desktop UA');
  assert(ipadMount.btnListeners.length === 0, 'hidden iPad Record is not click-wired');

  const safariMount = createMountDoc();
  const safariCtx = loadRecorder(
    {
      ...macSafariNav,
      mediaDevices: { getUserMedia() {} },
    },
    { document: safariMount.doc }
  );
  safariCtx.mountChatRecorderUI({
    button: safariMount.btn,
    statusEl: safariMount.byId['session-record-hint'],
  });
  assert(safariMount.btn.hidden === false, 'desktop Safari still shows Record (not an iPhone hide)');
  assert(safariMount.btn.disabled === true, 'desktop Safari without getDisplayMedia stays disabled');
  assert(
    safariMount.btn.title === 'Recording not supported. Use Chrome on a computer.',
    'desktop Safari keeps the quiet unsupported title'
  );

  const desktopMount = createMountDoc();
  let desktopAlerted = false;
  const desktopMountCtx = loadRecorder(
    {
      ...desktopChromeNavBase,
      mediaDevices: {
        getDisplayMedia: async () => {
          const err = new Error('cancelled');
          err.name = 'AbortError';
          throw err;
        },
        getUserMedia: async () => new FakeStream([new FakeTrack('audio')]),
      },
    },
    {
      document: desktopMount.doc,
      alert() {
        desktopAlerted = true;
      },
    }
  );
  desktopMountCtx.mountChatRecorderUI({
    button: desktopMount.btn,
    statusEl: desktopMount.byId['session-record-hint'],
  });
  assert(desktopMount.btn.hidden === false, 'desktop Chrome still shows Record');
  assert(desktopMount.btn.disabled === false, 'desktop Chrome keeps Record enabled');
  assert(
    desktopMount.btn.title === 'Record screen + conversation (Chrome recommended)',
    'desktop Chrome keeps Chrome-recommended title'
  );
  assert(desktopMount.btnListeners.length > 0, 'desktop Chrome Record click stays wired');
  await desktopMount.btnListeners[0]({ preventDefault() {} });
  assert(desktopAlerted === true, 'desktop first-time tip still appears');
  assert(
    desktopMount.doc.getElementById('session-record-ios-guide') == null,
    'desktop Record must not create an iOS guide'
  );

  console.log('chat-recorder.test.js: ok');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
