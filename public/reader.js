(function () {
  'use strict';

  const BC = window.BibleCore;
  const AE = window.AudioEngine;
  const SC = window.StudyCore;
  if (!BC) return;

  const synth = window.speechSynthesis;
  let currentBook = null;
  let currentChapter = 1;
  let chapterBlocks = [];
  let navBook = null;
  let sheetTab = 'books';
  let audioQueue = [];
  let audioIndex = 0;
  let audioPlaying = false;
  let audioPaused = false;
  let audioMode = 'browser';
  let audioCatalogLoaded = false;
  let chapterAudioLinks = null;
  let chapterPayload = null;
  let selectedVerses = new Set(); // verse numbers in current chapter
  let lastTappedVerse = null;
  let openStudyVerseNum = null;
  let scrollHideTimer = null;
  let lastScrollY = 0;
  const SITE_SHARE_URL = 'https://www.thewordincontext.org';
  let selectionBarEl = null;
  let shareMenuCloseHandler = null;

  const els = {
    header: document.getElementById('reader-header'),
    audioBar: document.getElementById('audio-bar'),
    main: document.getElementById('reader-main'),
    scroll: document.getElementById('reader-scroll'),
    headerBook: document.getElementById('header-book'),
    headerChapter: document.getElementById('header-chapter'),
    loading: document.getElementById('reader-loading'),
    overlay: document.getElementById('nav-overlay'),
    sheet: document.getElementById('nav-sheet'),
    navBody: document.getElementById('nav-body'),
    navTrans: document.getElementById('nav-trans-select'),
    btnPlay: document.getElementById('btn-audio-play'),
    btnAudioMode: document.getElementById('btn-audio-mode'),
    audioLabel: document.getElementById('audio-label'),
    audioProgress: document.getElementById('audio-progress'),
    continueWrap: document.getElementById('continue-wrap'),
    continueCard: document.getElementById('continue-card'),
    continueRef: document.getElementById('continue-ref')
  };

  function isDark() {
    return localStorage.getItem('dark_mode') === 'true';
  }

  function applyTheme() {
    document.documentElement.setAttribute('data-theme', isDark() ? 'dark' : 'light');
  }

  function getVoiceId() {
    return localStorage.getItem('reader_voice_id')
      || localStorage.getItem('voice_id')
      || localStorage.getItem('voice_name')
      || '';
  }

  function setVoiceId(name) {
    localStorage.setItem('reader_voice_id', name);
    localStorage.setItem('voice_id', name);
    if (AE && AE.isHelloaoVoice(name)) {
      localStorage.setItem('reader_last_helloao_voice', AE.helloaoSlug(name));
    } else if (AE && AE.isPregenVoice(name)) {
      localStorage.setItem('reader_last_pregen_voice', AE.pregenSlug(name));
    } else if (name && (!AE || (!AE.isHelloaoVoice(name) && !AE.isPregenVoice(name)))) {
      localStorage.setItem('reader_last_system_voice', name);
    }
    updateAudioChrome();
  }

  function getAudioMode() {
    if (currentTranslationId() !== 'BSB') return 'system';
    const mode = BC.getReaderSettings().audioMode;
    return mode === 'system' ? 'system' : 'helloao';
  }

  function setAudioMode(mode) {
    const next = mode === 'system' ? 'system' : 'helloao';
    BC.saveReaderSettings({ audioMode: next });
    stopAudio();

    if (next === 'helloao' && AE && currentTranslationId() === 'BSB') {
      const slug = localStorage.getItem('reader_last_helloao_voice') || 'david';
      setVoiceId(AE.toHelloaoVoiceId(slug));
    } else {
      const saved = localStorage.getItem('reader_last_system_voice')
        || localStorage.getItem('voice_name')
        || localStorage.getItem('voice_id')
        || '';
      const voice = findVoiceByName(saved);
      if (voice) {
        setVoiceId(voice.name);
      } else {
        const cats = categorizeVoices();
        const fallback = cats.saved || cats.enhanced[0] || cats.grokStyle[0] || cats.all[0];
        if (fallback) setVoiceId(fallback.name);
      }
    }
    updateAudioChrome();
    if (sheetTab === 'settings') renderNavBody();
  }

  function toggleAudioMode() {
    setAudioMode(getAudioMode() === 'helloao' ? 'system' : 'helloao');
  }

  function refreshSystemVoices() {
    try {
      synth.getVoices();
      if (typeof synth.cancel === 'function') synth.cancel();
    } catch (e) { /* ignore */ }
    if (sheetTab === 'settings') renderNavBody();
    updateAudioChrome();
  }

  function resolveSystemVoice() {
    const id = getVoiceId();
    if (AE && (AE.isHelloaoVoice(id) || AE.isPregenVoice(id))) {
      const saved = localStorage.getItem('reader_last_system_voice')
        || localStorage.getItem('voice_name')
        || '';
      return findVoiceByName(saved);
    }
    return findVoiceByName(id);
  }

  function voiceModeLabel() {
    if (getAudioMode() === 'helloao' && AE) {
      const slug = AE.helloaoSlug(getVoiceId());
      const n = AE.HELLOAO_BSB_NARRATORS.find((x) => x.slug === slug);
      return n ? `BSB · ${n.label}` : 'BSB Audio';
    }
    const v = resolveSystemVoice();
    return v ? `Device · ${v.name.replace(/\s*\(System\)\s*$/i, '').slice(0, 18)}` : 'Device voice';
  }

  function updateAudioChrome() {
    const isBsb = currentTranslationId() === 'BSB';
    if (els.btnAudioMode) {
      els.btnAudioMode.hidden = !isBsb;
      if (isBsb) {
        const helloao = getAudioMode() === 'helloao';
        els.btnAudioMode.textContent = helloao ? 'BSB' : 'Device';
        els.btnAudioMode.classList.toggle('active-mode', helloao);
        els.btnAudioMode.title = helloao
          ? 'Using BSB chapter audio — tap to switch to device voice'
          : 'Using device voice — tap to switch to BSB audio';
      }
    }
    if (!audioPlaying && els.audioLabel) {
      const idle = isBsb && getAudioMode() === 'helloao'
        ? 'Listen to chapter (BSB audio)'
        : 'Listen to chapter';
      if (els.audioLabel.textContent === 'Listen to chapter'
        || els.audioLabel.textContent === 'Listen to chapter (BSB audio)'
        || els.audioLabel.textContent === 'Chapter complete') {
        els.audioLabel.textContent = idle;
      }
    }
  }

  function migrateAudioSettings() {
    const s = BC.getReaderSettings();
    if (s.audioMode === 'system' || s.audioMode === 'helloao') return;
    if (AE && AE.isHelloaoVoice(getVoiceId())) {
      BC.saveReaderSettings({ audioMode: 'helloao' });
    } else {
      BC.saveReaderSettings({ audioMode: 'system' });
    }
  }

  function getVoices() {
    try { return synth.getVoices() || []; } catch (e) { return []; }
  }

  function findVoiceByName(name) {
    if (!name) return null;
    const voices = getVoices();
    const norm = name.replace(/\s*\(System\)\s*$/i, '').trim();
    return voices.find((v) => v.name === name)
      || voices.find((v) => v.name === norm)
      || voices.find((v) => v.name.toLowerCase().includes(norm.toLowerCase()));
  }

  function getTools() {
    return BC.getReaderSettings().tools || {
      speaker: true,
      bookmark: true,
      highlight: true,
      wordStudy: true
    };
  }

  function escapeHtml(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function escapeAttr(s) {
    return escapeHtml(s).replace(/'/g, '&#39;');
  }

  function clearVerseSelection() {
    selectedVerses = new Set();
    lastTappedVerse = null;
    openStudyVerseNum = null;
    document.querySelectorAll('.reader-verse.selected-verse').forEach((el) => el.classList.remove('selected-verse'));
    document.querySelectorAll('.reader-study-panel').forEach((el) => { el.hidden = true; });
    updateSelectionBar();
  }

  function sortedSelectedVerses() {
    return [...selectedVerses].sort((a, b) => a - b);
  }

  function verseBlockByNumber(num) {
    return chapterBlocks.find((b) => b.type !== 'heading' && Number(b.number) === Number(num));
  }

  function formatVerseRangeRef(bookName, chapter, nums) {
    const sorted = [...nums].sort((a, b) => a - b);
    if (!sorted.length) return `${bookName} ${chapter}`;
    const parts = [];
    let start = sorted[0];
    let end = sorted[0];
    for (let i = 1; i < sorted.length; i++) {
      if (sorted[i] === end + 1) {
        end = sorted[i];
      } else {
        parts.push(start === end ? String(start) : `${start}–${end}`);
        start = end = sorted[i];
      }
    }
    parts.push(start === end ? String(start) : `${start}–${end}`);
    return `${bookName} ${chapter}:${parts.join(', ')}`;
  }

  function productionShareUrl(url) {
    if (!url || /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?/i.test(url)) {
      return SITE_SHARE_URL;
    }
    return String(url)
      .replace(/^http:\/\//i, 'https://')
      .replace(/:\/\/word-in-context\.onrender\.com/i, '://www.thewordincontext.org');
  }

  function readerDeepLink(verseNum) {
    if (!currentBook) return `${SITE_SHARE_URL}/read`;
    const v = verseNum ? `/${verseNum}` : '';
    return `${SITE_SHARE_URL}/read#/${currentBook.code}/${currentChapter}${v}`;
  }

  /** Plain-text body only — never HTML. Safe for SMS, iMessage, Notes, Facebook paste. */
  function formatSelectedVersesBody() {
    const nums = sortedSelectedVerses();
    if (!nums.length || !chapterPayload) return '';
    const bookName = chapterPayload.bookName || (currentBook && currentBook.name) || 'Scripture';
    const transMeta = BC.translationMeta(BC.getTranslationId());
    const trans = (transMeta && (transMeta.short || transMeta.id)) || BC.getTranslationId() || '';
    const ref = formatVerseRangeRef(bookName, currentChapter, nums);
    const lines = nums.map((n) => {
      const block = verseBlockByNumber(n);
      const text = block ? String(block.text || '').trim() : '';
      return text ? `${n} ${text}` : String(n);
    });
    return `${ref}${trans ? ` (${trans})` : ''}\n\n${lines.join('\n')}`;
  }

  function appendShareLink(bodyText, sharePageUrl) {
    const link = productionShareUrl(sharePageUrl || SITE_SHARE_URL);
    const body = String(bodyText || '').trim();
    // Explicit plain-text footer so Messages/SMS never get HTML or “code”
    return `${body}\n\n— The Word in Context\n${link}`;
  }

  async function createShareRecord(payload) {
    const res = await fetch('/api/share', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    if (!res.ok) throw new Error('Share create failed');
    return res.json();
  }

  async function buildSelectedShareContent() {
    const bodyText = formatSelectedVersesBody();
    const nums = sortedSelectedVerses();
    const bookName = (chapterPayload && chapterPayload.bookName) || 'Scripture';
    const transMeta = BC.translationMeta(BC.getTranslationId());
    const trans = (transMeta && (transMeta.short || transMeta.id)) || BC.getTranslationId() || '';
    const reference = formatVerseRangeRef(bookName, currentChapter, nums);
    const title = reference || 'Scripture';
    // Combined verse text for OG preview (plain)
    const verseText = nums.map((n) => {
      const block = verseBlockByNumber(n);
      return block ? String(block.text || '').trim() : '';
    }).filter(Boolean).join(' ');

    let sharePageUrl = readerDeepLink(nums[0] || null);
    try {
      const data = await createShareRecord({
        type: 'verse',
        reference,
        translation: trans,
        text: verseText.slice(0, 6000)
      });
      if (data && data.url) sharePageUrl = productionShareUrl(data.url);
    } catch (e) {
      sharePageUrl = productionShareUrl(sharePageUrl);
    }

    return {
      title: `${title} — The Word in Context`,
      bodyText,
      sharePageUrl: productionShareUrl(sharePageUrl),
      textWithLink: appendShareLink(bodyText, sharePageUrl)
    };
  }

  /** Copy only plain text (text/plain). Avoids HTML “code” when pasting into Messages. */
  async function copyPlainText(text) {
    const plain = String(text || '').replace(/\r\n/g, '\n');
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        await navigator.clipboard.writeText(plain);
        return true;
      }
    } catch (e) { /* fall through */ }
    try {
      const ta = document.createElement('textarea');
      ta.value = plain;
      ta.setAttribute('readonly', '');
      ta.style.cssText = 'position:fixed;left:-9999px;top:0;opacity:0;';
      document.body.appendChild(ta);
      ta.focus();
      ta.select();
      ta.setSelectionRange(0, plain.length);
      const ok = document.execCommand('copy');
      ta.remove();
      return !!ok;
    } catch (e) {
      return false;
    }
  }

  function showShareToast(message, ok) {
    const existing = document.getElementById('reader-share-toast');
    if (existing) existing.remove();
    const toast = document.createElement('div');
    toast.id = 'reader-share-toast';
    toast.className = 'reader-share-toast' + (ok ? '' : ' failed');
    toast.setAttribute('role', 'status');
    toast.textContent = message;
    document.body.appendChild(toast);
    setTimeout(() => toast.remove(), 3200);
  }

  function closeReaderShareMenu() {
    const menu = document.getElementById('reader-share-menu');
    const backdrop = document.getElementById('reader-share-backdrop');
    if (menu) menu.remove();
    if (backdrop) backdrop.remove();
    if (shareMenuCloseHandler) {
      document.removeEventListener('keydown', shareMenuCloseHandler);
      shareMenuCloseHandler = null;
    }
  }

  function getSelectedVerseObjects() {
    return sortedSelectedVerses().map((n) => {
      const block = verseBlockByNumber(n);
      return { number: n, text: block ? String(block.text || '').trim() : '' };
    }).filter((v) => v.text);
  }

  function closeVideoProgressModal() {
    const el = document.getElementById('reader-video-modal');
    if (el) el.remove();
  }

  function showVideoProgressModal() {
    closeVideoProgressModal();
    const backdrop = document.createElement('div');
    backdrop.id = 'reader-video-modal';
    backdrop.className = 'reader-video-modal';
    backdrop.innerHTML = `
      <div class="reader-video-panel" role="dialog" aria-modal="true" aria-labelledby="reader-video-title">
        <h3 id="reader-video-title">Creating voice video</h3>
        <p class="reader-video-status" id="reader-video-status">Preparing…</p>
        <div class="reader-video-bar"><div class="reader-video-bar-fill" id="reader-video-bar-fill"></div></div>
        <p class="reader-video-hint">Keep this screen open. You will hear the narration while the video is made, then you can post it.</p>
        <button type="button" class="reader-video-cancel" id="reader-video-cancel">Cancel</button>
      </div>
    `;
    document.body.appendChild(backdrop);
    return {
      setProgress(pct, label) {
        const fill = document.getElementById('reader-video-bar-fill');
        const status = document.getElementById('reader-video-status');
        if (fill) fill.style.width = `${Math.round(Math.max(0, Math.min(1, pct)) * 100)}%`;
        if (status && label) status.textContent = label;
      },
      onCancel(fn) {
        const btn = document.getElementById('reader-video-cancel');
        if (btn) btn.addEventListener('click', fn);
      },
      close: closeVideoProgressModal
    };
  }

  function closeShareResultModal() {
    const el = document.getElementById('reader-share-result-modal');
    if (!el) return;
    const vid = el.querySelector('video');
    if (vid) {
      try { vid.pause(); } catch (e) {}
      try { URL.revokeObjectURL(vid.src); } catch (e) {}
    }
    const img = el.querySelector('img.reader-share-result-media');
    if (img && img.src && img.src.startsWith('blob:')) {
      try { URL.revokeObjectURL(img.src); } catch (e) {}
    }
    el.remove();
  }

  function isIOSLike() {
    return /iPad|iPhone|iPod/i.test(navigator.userAgent || '')
      || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  }

  /** Desktop Mac/Windows — system Share does NOT list Facebook/YouTube (OS limit). */
  function isDesktopComputer() {
    const ua = navigator.userAgent || '';
    if (/iPhone|iPad|iPod|Android/i.test(ua)) return false;
    if (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1) return false; // iPad
    return /Macintosh|Mac OS X|Windows|Linux|CrOS/i.test(ua) || !('ontouchstart' in window);
  }

  /**
   * iOS: sharing { files + text } often opens only Messages.
   * Sharing { files } alone surfaces Save Video, Photos, Facebook, Instagram, etc.
   * Mac desktop Share sheet: mostly Messages/Mail/AirDrop — not social apps.
   */
  function prepareShareFile(file) {
    const isImage = /^image\//i.test(file.type || '');
    if (isImage) {
      const name = /\.(png|jpe?g|webp)$/i.test(file.name || '') ? file.name : 'scripture-share.png';
      return new File([file], name, { type: file.type || 'image/png' });
    }
    const name = /\.mp4$/i.test(file.name || '') ? file.name : 'word-in-context-reel.mp4';
    const type = /mp4/i.test(file.type || '') ? 'video/mp4' : (file.type || 'video/mp4');
    return new File([file], name, { type });
  }

  async function nativeShareMediaOnly(file) {
    const shareFile = prepareShareFile(file);
    if (!(navigator.canShare && navigator.canShare({ files: [shareFile] }))) {
      throw new Error('File share not supported');
    }
    await navigator.share({ files: [shareFile] });
  }

  async function nativeShareCaptionOnly(caption, title) {
    if (!navigator.share) throw new Error('Share not supported');
    await navigator.share({
      title: title || 'The Word in Context',
      text: caption || ''
    });
  }

  function triggerDownload(objectUrl, filename) {
    const a = document.createElement('a');
    a.href = objectUrl;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
  }

  /**
   * Keep media in-app: preview + platform-aware share actions.
   * Desktop Mac: Save MP4 + open Facebook/YouTube (system Share won't show social apps).
   * iPhone: files-only share sheet for Save Video / more apps.
   */
  async function showShareResultModal({ file, caption, title }) {
    closeShareResultModal();
    await copyPlainText(caption || '');

    const shareFile = prepareShareFile(file);
    const isImage = /^image\//i.test(shareFile.type || '');
    const isMp4 = /mp4/i.test(shareFile.type || '') || /\.mp4$/i.test(shareFile.name || '');
    const objectUrl = URL.createObjectURL(shareFile);
    const canNativeShare = !!(navigator.share);
    let canFileShare = false;
    try {
      canFileShare = !!(navigator.canShare && navigator.canShare({ files: [shareFile] }));
    } catch (e) {
      canFileShare = false;
    }
    const ios = isIOSLike();
    const desktop = isDesktopComputer();
    const kind = isImage ? 'image' : 'video';
    const saveName = shareFile.name || (isImage ? 'scripture.png' : 'word-in-context-reel.mp4');

    // Desktop: Save is primary. Phone: Share video is primary when available.
    const primarySave = desktop || !canFileShare;
    const hint = desktop
      ? '<strong>On a Mac,</strong> the system Share menu only shows Messages/Mail/AirDrop — not Facebook. Use <strong>Download MP4</strong>, then open Facebook Reels or YouTube and upload that file. Caption is already copied.'
      : (canFileShare
        ? (ios
          ? '<strong>Tip:</strong> Tap <em>Share video</em>, then <strong>Save Video</strong>. Open Facebook → Reels → pick from gallery. Paste caption.'
          : 'Share the video file, or download and upload to Facebook / YouTube.')
        : 'Download the file, then upload in Facebook Reels or YouTube Shorts. Caption is copied.');

    const backdrop = document.createElement('div');
    backdrop.id = 'reader-share-result-modal';
    backdrop.className = 'reader-video-modal reader-share-result-modal';
    backdrop.innerHTML = `
      <div class="reader-video-panel reader-share-result-panel" role="dialog" aria-modal="true" aria-labelledby="reader-share-result-title">
        <h3 id="reader-share-result-title">${isImage ? 'Share image ready' : 'Share video ready'}</h3>
        <div class="reader-share-result-preview" id="reader-share-result-preview"></div>
        <p class="reader-share-result-meta">
          ${isImage ? 'PNG image' : (isMp4 ? 'MP4 · ready for Reels / Shorts' : 'Video file')}
          · Caption copied
        </p>
        <p class="reader-video-hint" id="srs-hint">${hint}</p>
        <div class="reader-share-result-actions">
          <button type="button" class="reader-selection-btn ${primarySave ? 'primary' : ''}" id="srs-save">
            ${desktop ? `1. Download ${isImage ? 'image' : 'MP4'}` : `Save ${kind} to device`}
          </button>
          <button type="button" class="reader-selection-btn ${!primarySave ? 'primary' : ''}" id="srs-facebook">
            ${desktop ? '2. Open Facebook Reels' : 'Facebook Reels'}
          </button>
          <button type="button" class="reader-selection-btn" id="srs-youtube">
            ${desktop ? '2. Open YouTube upload' : 'YouTube Shorts'}
          </button>
          <button type="button" class="reader-selection-btn" id="srs-caption">Copy caption again</button>
          ${(!desktop && canFileShare) ? `<button type="button" class="reader-selection-btn" id="srs-share-media">Share ${kind} via system…</button>` : ''}
          ${(!desktop && canNativeShare) ? '<button type="button" class="reader-selection-btn" id="srs-share-caption">Share caption only…</button>' : ''}
          ${desktop && canNativeShare ? '<button type="button" class="reader-selection-btn" id="srs-share-caption">Mac Share (Messages / Mail)…</button>' : ''}
          <button type="button" class="reader-selection-btn ghost" id="srs-close">Done</button>
        </div>
      </div>
    `;
    document.body.appendChild(backdrop);

    const preview = backdrop.querySelector('#reader-share-result-preview');
    if (isImage) {
      const img = document.createElement('img');
      img.className = 'reader-share-result-media';
      img.src = objectUrl;
      img.alt = title || 'Scripture share';
      preview.appendChild(img);
    } else {
      const video = document.createElement('video');
      video.className = 'reader-share-result-media';
      video.src = objectUrl;
      video.controls = true;
      video.playsInline = true;
      video.setAttribute('playsinline', '');
      video.preload = 'metadata';
      preview.appendChild(video);
    }

    backdrop.addEventListener('click', (e) => {
      if (e.target === backdrop) closeShareResultModal();
    });

    const doSave = () => {
      triggerDownload(objectUrl, saveName);
      showShareToast(
        desktop
          ? 'Downloaded — next: open Facebook or YouTube and upload that file. Caption is copied.'
          : 'Saved — open Facebook Reels or YouTube Shorts from gallery',
        true
      );
    };

    backdrop.querySelector('#srs-save').addEventListener('click', async () => {
      if (!desktop && canFileShare && ios) {
        try {
          await nativeShareMediaOnly(shareFile);
          showShareToast('Choose “Save Video” / Photos in the sheet', true);
          return;
        } catch (e) {
          if (e && e.name === 'AbortError') return;
        }
      }
      doSave();
    });

    backdrop.querySelector('#srs-facebook').addEventListener('click', async () => {
      await copyPlainText(caption || '');
      if (desktop) {
        // Auto-download so the file is ready, then open Facebook create
        triggerDownload(objectUrl, saveName);
        setTimeout(() => {
          window.open('https://www.facebook.com/reels/create', '_blank', 'noopener,noreferrer');
        }, 400);
        showShareToast('MP4 downloading → Facebook Reels opening. Upload the file & paste caption.', true);
        return;
      }
      if (canFileShare) {
        try {
          await nativeShareMediaOnly(shareFile);
          showShareToast('If Facebook is missing: Save Video → Facebook → Reels → gallery. Paste caption.', true);
          return;
        } catch (e) {
          if (e && e.name === 'AbortError') return;
        }
      }
      window.open('https://m.facebook.com/', '_blank', 'noopener,noreferrer');
      showShareToast('Save the video, then create a Reel from gallery. Caption copied.', true);
    });

    backdrop.querySelector('#srs-youtube').addEventListener('click', async () => {
      await copyPlainText(caption || '');
      if (desktop) {
        triggerDownload(objectUrl, saveName);
        setTimeout(() => {
          window.open('https://www.youtube.com/upload', '_blank', 'noopener,noreferrer');
        }, 400);
        showShareToast('MP4 downloading → YouTube opening. Upload as a Short & paste caption.', true);
        return;
      }
      if (canFileShare) {
        try {
          await nativeShareMediaOnly(shareFile);
          showShareToast('Pick YouTube if listed, or Save then upload a Short', true);
          return;
        } catch (e) {
          if (e && e.name === 'AbortError') return;
        }
      }
      window.open('https://www.youtube.com/upload', '_blank', 'noopener,noreferrer');
      showShareToast('Save the video, then upload as a Short. Caption copied.', true);
    });

    backdrop.querySelector('#srs-caption').addEventListener('click', async () => {
      const ok = await copyPlainText(caption || '');
      showShareToast(ok ? 'Caption copied (verses + app link)' : 'Copy failed', ok);
    });

    const mediaBtn = backdrop.querySelector('#srs-share-media');
    if (mediaBtn) {
      mediaBtn.addEventListener('click', async () => {
        try {
          await nativeShareMediaOnly(shareFile);
          showShareToast('Choose Save Video or another app (swipe for more)', true);
        } catch (e) {
          if (e && e.name === 'AbortError') return;
          showShareToast('Use Download instead', false);
        }
      });
    }

    const captionShareBtn = backdrop.querySelector('#srs-share-caption');
    if (captionShareBtn) {
      captionShareBtn.addEventListener('click', async () => {
        try {
          await nativeShareCaptionOnly(caption || '', title);
        } catch (e) {
          if (e && e.name === 'AbortError') return;
          const ok = await copyPlainText(caption || '');
          showShareToast(ok ? 'Caption copied instead' : 'Share not available', ok);
        }
      });
    }

    backdrop.querySelector('#srs-close').addEventListener('click', () => closeShareResultModal());
    return true;
  }

  async function shareVideoFile(file, caption, title) {
    // In-app result UI (no automatic download to the computer)
    return showShareResultModal({ file, caption, title });
  }

  function getSelectionShareMeta() {
    const verses = getSelectedVerseObjects();
    const bookName = (chapterPayload && chapterPayload.bookName) || 'Scripture';
    const transMeta = BC.translationMeta(BC.getTranslationId());
    const translation = (transMeta && (transMeta.short || transMeta.id)) || BC.getTranslationId() || '';
    const reference = formatVerseRangeRef(bookName, currentChapter, sortedSelectedVerses());
    return { verses, translation, reference };
  }

  async function createAndShareImageCard() {
    if (!selectedVerses.size) return;
    if (!window.ShareVideo || !window.ShareVideo.createShareCardPng) {
      showShareToast('Share image not loaded — refresh the page', false);
      return;
    }
    const { verses, translation, reference } = getSelectionShareMeta();
    if (!verses.length) {
      showShareToast('No verse text', false);
      return;
    }
    try {
      showShareToast('Creating image…', true);
      const content = await buildSelectedShareContent();
      const result = await window.ShareVideo.createShareCardPng({
        reference,
        translation,
        verses,
        siteUrl: 'thewordincontext.org'
      });
      const file = new File([result.blob], result.filename, { type: result.mimeType });
      await copyPlainText(content.textWithLink);
      showShareToast('Image ready — caption copied (includes app link)', true);
      await shareVideoFile(file, content.textWithLink, content.title);
    } catch (err) {
      console.error('[share-image]', err);
      showShareToast((err && err.message) || 'Could not create image', false);
    }
  }

  async function createAndShareVoiceVideo() {
    if (!selectedVerses.size) return;
    if (!window.ShareVideo) {
      showShareToast('Voice video module not loaded — refresh the page', false);
      return;
    }

    // Refresh config in case admin just toggled
    try {
      const cfg = await fetch('/api/config').then((r) => r.json());
      if (cfg && cfg.shareTts) window.__shareTtsConfig = cfg.shareTts;
    } catch (e) {}
    const stts = window.__shareTtsConfig || {};
    if (stts.enabled === false) {
      showShareToast('Voice video is turned off by the site admin', false);
      return;
    }
    if (stts.requireAuth) {
      const token = localStorage.getItem('auth_token');
      if (!token) {
        showShareToast('Sign in to create voice videos', false);
        return;
      }
    }

    const SV = window.ShareVideo;
    const { verses, translation, reference } = getSelectionShareMeta();
    if (!verses.length) {
      showShareToast('No verse text to narrate', false);
      return;
    }

    const content = await buildSelectedShareContent();
    const narration = SV.buildNarrationText(reference, translation, verses);

    if (narration.length > 4000) {
      showShareToast('Selection too long for one video — select fewer verses', false);
      return;
    }

    const abort = new AbortController();
    const modal = showVideoProgressModal();
    modal.onCancel(() => abort.abort());

    // Includes optional one-time MP4 converter download (~25MB) on desktop Chrome
    const overallTimer = setTimeout(() => {
      try { abort.abort(); } catch (e) {}
      modal.close();
      showShareToast('Video timed out — try fewer verses, Share image, or text', false);
    }, 6 * 60 * 1000);

    try {
      modal.setProgress(0.05, 'Generating narration…');
      let audioBuf = null;
      let voiceNote = '';
      try {
        const ttsAbort = new AbortController();
        const ttsTimer = setTimeout(() => ttsAbort.abort(), 45000);
        const onParentAbort = () => ttsAbort.abort();
        abort.signal.addEventListener('abort', onParentAbort, { once: true });
        try {
          audioBuf = await SV.fetchShareTts(narration, ttsAbort.signal);
        } finally {
          clearTimeout(ttsTimer);
          abort.signal.removeEventListener('abort', onParentAbort);
        }
      } catch (e) {
        if (abort.signal.aborted) throw new DOMException('Aborted', 'AbortError');
        if (e && e.name === 'AbortError') voiceNote = 'Voice timed out';
        else voiceNote = e && e.message ? e.message : 'Voice unavailable';
        modal.setProgress(0.18, 'Building branded video…');
      }

      if (abort.signal.aborted) throw new DOMException('Aborted', 'AbortError');

      let result = await SV.createScriptureVideo({
        reference,
        translation,
        verses,
        audioArrayBuffer: audioBuf,
        siteUrl: 'thewordincontext.org',
        signal: abort.signal,
        onProgress: (pct, label) => modal.setProgress(pct, label)
      });

      // Convert WebM → MP4 so Facebook Reels / YouTube Shorts accept it
      if (result.kind !== 'image' && !result.videoFailed && SV.ensureMp4) {
        modal.setProgress(0.92, 'Making MP4 for Facebook / YouTube…');
        try {
          const ensured = await SV.ensureMp4(result.blob, result.filename, (pct, label) => {
            modal.setProgress(0.92 + (pct || 0) * 0.07, label || 'Making MP4…');
          });
          result = {
            ...result,
            blob: ensured.blob,
            mimeType: ensured.mimeType,
            filename: ensured.filename,
            convertFailed: ensured.convertFailed
          };
        } catch (e) {
          console.warn('[voice-video] mp4 ensure failed', e);
        }
      }

      clearTimeout(overallTimer);
      modal.close();

      const file = new File([result.blob], result.filename, { type: result.mimeType });

      if (result.kind === 'image' || result.videoFailed) {
        showShareToast('Image card ready in-app (device could not make video).', true);
      } else if (result.convertFailed) {
        showShareToast('Video ready — MP4 convert skipped; Share to apps or Save.', true);
      } else if (result.hadVoice) {
        showShareToast('Video ready in-app (text + voice).', true);
      } else {
        showShareToast((voiceNote ? voiceNote + ' — ' : '') + 'Video ready in-app.', true);
      }

      await shareVideoFile(file, content.textWithLink, content.title);
    } catch (err) {
      clearTimeout(overallTimer);
      modal.close();
      if (err && err.name === 'AbortError') {
        showShareToast('Cancelled', true);
        return;
      }
      console.error('[voice-video]', err);
      // Last resort: still card
      try {
        const card = await SV.createShareCardPng({
          reference,
          translation,
          verses,
          siteUrl: 'thewordincontext.org'
        });
        const file = new File([card.blob], card.filename, { type: card.mimeType });
        await copyPlainText(content.textWithLink);
        showShareToast('Video failed — image card ready instead. Caption copied.', true);
        await shareVideoFile(file, content.textWithLink, content.title);
      } catch (e2) {
        showShareToast((err && err.message) || 'Could not create video — try Share as text', false);
      }
    }
  }

  function speakSelectedAloud() {
    const verses = getSelectedVerseObjects();
    if (!verses.length) return;
    const bookName = (chapterPayload && chapterPayload.bookName) || 'Scripture';
    const reference = formatVerseRangeRef(bookName, currentChapter, sortedSelectedVerses());
    const text = `${reference}. ${verses.map((v) => v.text).join(' ')}`;
    stopAudio();
    showShareToast('Speaking with your device voice…', true);
    speakText(text, () => {
      showShareToast('Done speaking', true);
    });
  }

  function openReaderShareMenu(anchorEl) {
    closeReaderShareMenu();
    if (!selectedVerses.size) return;

    const backdrop = document.createElement('div');
    backdrop.id = 'reader-share-backdrop';
    backdrop.className = 'reader-share-backdrop';
    backdrop.addEventListener('click', closeReaderShareMenu);

    const menu = document.createElement('div');
    menu.id = 'reader-share-menu';
    menu.className = 'reader-share-menu';
    menu.setAttribute('role', 'menu');
    menu.innerHTML = `
      <div class="reader-share-menu-title">How do you want to share?</div>
      <div class="reader-share-section-label">Text</div>
    `;

    const addItem = (label, icon, onClick, className) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'reader-share-menu-item' + (className ? ` ${className}` : '');
      btn.setAttribute('role', 'menuitem');
      btn.innerHTML = `<span class="share-icon" aria-hidden="true">${icon}</span><span>${label}</span>`;
      btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        closeReaderShareMenu();
        try {
          await onClick();
        } catch (err) {
          if (err && err.name !== 'AbortError') {
            showShareToast((err && err.message) || 'Share failed — try Copy text', false);
          }
        }
      });
      menu.appendChild(btn);
    };

    const addSection = (label) => {
      const div = document.createElement('div');
      div.className = 'reader-share-section-label';
      div.textContent = label;
      menu.appendChild(div);
    };

    // System share sheet (Messages, Mail, Facebook app, etc.) — PLAIN TEXT only.
    // Important: do not pass both text (with URL) and a separate url field on iOS —
    // that often produces broken “code” or duplicate links in Messages.
    if (navigator.share) {
      addItem('Messages / Apps…', '📤', async () => {
        const content = await buildSelectedShareContent();
        await navigator.share({
          title: content.title,
          text: content.textWithLink
        });
      });
    }

    addItem('Copy text + link', '📋', async () => {
      const content = await buildSelectedShareContent();
      const ok = await copyPlainText(content.textWithLink);
      showShareToast(ok ? 'Copied — paste into any app' : 'Copy failed', ok);
    });

    addItem('Facebook', 'f', async () => {
      const content = await buildSelectedShareContent();
      const ok = await copyPlainText(content.textWithLink);
      showShareToast(ok ? 'Copied — paste into your Facebook post' : 'Could not copy', ok);
      const publicUrl = productionShareUrl(content.sharePageUrl);
      const mobile = /iPhone|iPad|iPod|Android/i.test(navigator.userAgent);
      const fbUrl = mobile
        ? `https://m.facebook.com/sharer.php?u=${encodeURIComponent(publicUrl)}`
        : `https://www.facebook.com/sharer/sharer.php?u=${encodeURIComponent(publicUrl)}`;
      window.open(fbUrl, '_blank', 'noopener,noreferrer');
    });

    addItem('X (Twitter)', '𝕏', async () => {
      const content = await buildSelectedShareContent();
      window.open(
        `https://twitter.com/intent/tweet?text=${encodeURIComponent(content.textWithLink)}`,
        '_blank',
        'noopener,noreferrer'
      );
    });

    addItem('WhatsApp', '💬', async () => {
      const content = await buildSelectedShareContent();
      window.open(
        `https://wa.me/?text=${encodeURIComponent(content.textWithLink)}`,
        '_blank',
        'noopener,noreferrer'
      );
    });

    addItem('Email', '✉️', async () => {
      const content = await buildSelectedShareContent();
      window.location.href = `mailto:?subject=${encodeURIComponent(content.title)}&body=${encodeURIComponent(content.textWithLink)}`;
    });

    addSection('Voice & image');
    // Voice video shown when server config allows it (admin toggle + key + daily limit).
    const stts = window.__shareTtsConfig || { enabled: true };
    if (stts.enabled !== false) {
      addItem('Create voice video', '🎬', () => createAndShareVoiceVideo(), 'featured');
    }
    addItem('Share image card', '🖼️', () => createAndShareImageCard());
    addItem('Speak aloud now', '🔊', () => speakSelectedAloud());

    document.body.appendChild(backdrop);
    document.body.appendChild(menu);

    // Position near anchor or bottom center
    const margin = 10;
    const rect = anchorEl ? anchorEl.getBoundingClientRect() : null;
    const menuRect = menu.getBoundingClientRect();
    let left = rect ? rect.left : (window.innerWidth - menuRect.width) / 2;
    let top = rect ? rect.top - menuRect.height - 8 : window.innerHeight / 3;
    if (left + menuRect.width > window.innerWidth - margin) left = window.innerWidth - menuRect.width - margin;
    if (left < margin) left = margin;
    if (top < margin) top = (rect ? rect.bottom + 8 : margin);
    // Keep menu on screen if tall
    if (top + menuRect.height > window.innerHeight - margin) {
      top = Math.max(margin, window.innerHeight - menuRect.height - margin);
    }
    menu.style.left = `${left}px`;
    menu.style.top = `${top}px`;

    shareMenuCloseHandler = (e) => {
      if (e.key === 'Escape') closeReaderShareMenu();
    };
    document.addEventListener('keydown', shareMenuCloseHandler);
  }

  function ensureSelectionBar() {
    if (selectionBarEl && document.body.contains(selectionBarEl)) return selectionBarEl;
    selectionBarEl = document.createElement('div');
    selectionBarEl.id = 'reader-selection-bar';
    selectionBarEl.className = 'reader-selection-bar';
    selectionBarEl.hidden = true;
    selectionBarEl.innerHTML = `
      <div class="reader-selection-count" id="reader-selection-count">0 selected</div>
      <div class="reader-selection-actions">
        <button type="button" class="reader-selection-btn" id="reader-sel-copy" title="Copy plain text + link">Copy</button>
        <button type="button" class="reader-selection-btn primary" id="reader-sel-share" title="Share to Messages, Facebook, and more">Share</button>
        <button type="button" class="reader-selection-btn" id="reader-sel-study" title="Word study" hidden>Study</button>
        <button type="button" class="reader-selection-btn ghost" id="reader-sel-clear" title="Clear selection">✕</button>
      </div>
    `;
    document.body.appendChild(selectionBarEl);

    selectionBarEl.querySelector('#reader-sel-copy').addEventListener('click', async () => {
      if (!selectedVerses.size) return;
      const content = await buildSelectedShareContent();
      const ok = await copyPlainText(content.textWithLink);
      showShareToast(
        ok
          ? 'Copied as plain text — paste in Messages, Facebook, etc.'
          : 'Copy failed — try Share instead',
        ok
      );
    });

    selectionBarEl.querySelector('#reader-sel-share').addEventListener('click', (e) => {
      openReaderShareMenu(e.currentTarget);
    });

    selectionBarEl.querySelector('#reader-sel-study').addEventListener('click', () => {
      const nums = sortedSelectedVerses();
      if (nums.length !== 1 || !currentBook) return;
      const block = verseBlockByNumber(nums[0]);
      const blockEl = document.querySelector(`.reader-verse-block[data-verse="${nums[0]}"]`);
      if (block && blockEl) openVerseStudy(block, blockEl);
    });

    selectionBarEl.querySelector('#reader-sel-clear').addEventListener('click', () => {
      clearVerseSelection();
    });

    return selectionBarEl;
  }

  function updateSelectionBar() {
    const bar = ensureSelectionBar();
    const n = selectedVerses.size;
    if (!n) {
      bar.hidden = true;
      document.body.classList.remove('reader-has-selection');
      return;
    }
    bar.hidden = false;
    document.body.classList.add('reader-has-selection');
    const countEl = bar.querySelector('#reader-selection-count');
    const nums = sortedSelectedVerses();
    const bookName = (chapterPayload && chapterPayload.bookName) || 'Verses';
    const ref = formatVerseRangeRef(bookName, currentChapter, nums);
    countEl.textContent = n === 1 ? ref : `${n} verses · ${ref}`;

    const studyBtn = bar.querySelector('#reader-sel-study');
    const tools = getTools();
    if (studyBtn) {
      studyBtn.hidden = !(tools.wordStudy && n === 1);
    }
  }

  function renderSelectionHighlights() {
    document.querySelectorAll('.reader-verse.selected-verse').forEach((el) => {
      el.classList.remove('selected-verse');
    });
    selectedVerses.forEach((num) => {
      const el = document.querySelector(`.reader-verse[data-verse="${num}"]`);
      if (el) el.classList.add('selected-verse');
    });
  }

  function toggleVerseSelection(num, evt) {
    const n = Number(num);
    if (!n) return;

    // Shift-click (desktop) or second-finger feel: select inclusive range from last tap
    const range = !!(evt && (evt.shiftKey || evt.altKey));
    if (range && lastTappedVerse != null) {
      const a = Math.min(lastTappedVerse, n);
      const b = Math.max(lastTappedVerse, n);
      for (let i = a; i <= b; i++) {
        if (verseBlockByNumber(i)) selectedVerses.add(i);
      }
    } else if (selectedVerses.has(n)) {
      selectedVerses.delete(n);
    } else {
      selectedVerses.add(n);
    }
    lastTappedVerse = n;
    renderSelectionHighlights();
    updateSelectionBar();
  }

  function renderStudyPanel(panelEl, study) {
    const wordsHtml = study.lexWords.length
      ? study.lexWords.map((w) => {
        const note = w.note ? `<div class="reader-study-word-note">${escapeHtml(w.note)}</div>` : '';
        return `<div class="reader-study-word"><strong>${escapeHtml(w.translit)}</strong> — ${escapeHtml(w.gloss)}${note}</div>`;
      }).join('')
      : `<p>No major ${escapeHtml(study.langLabel)} lexicon matches yet. The full original text is shown above.</p>`;

    const original = study.originalText
      ? `<div class="reader-study-original" dir="auto">${escapeHtml(study.originalText)}</div>`
      : `<p>${escapeHtml(study.langLabel)} text unavailable offline for this verse. Open once while online to cache.</p>`;

    panelEl.innerHTML = `
      <div class="reader-study-ref">${escapeHtml(study.ref)} · ${escapeHtml(study.translationShort)}</div>
      <div class="reader-study-section">
        <h4>${escapeHtml(study.langLabel)} · ${escapeHtml(study.originalLabel)}</h4>
        ${original}
      </div>
      <div class="reader-study-section">
        <h4>Key words</h4>
        ${wordsHtml}
      </div>
      <div class="reader-study-section">
        <h4>Context</h4>
        <div class="reader-study-context">${escapeHtml(study.contextNarrative)}</div>
      </div>
    `;
    panelEl.classList.remove('loading');
    panelEl.hidden = false;
  }

  async function openVerseStudy(block, blockEl) {
    if (!SC) return;
    const panelEl = blockEl.querySelector('.reader-study-panel');
    if (!panelEl || !chapterPayload || !currentBook) return;

    if (openStudyVerseNum === block.number && !panelEl.hidden) {
      panelEl.hidden = true;
      openStudyVerseNum = null;
      return;
    }

    document.querySelectorAll('.reader-study-panel').forEach((el) => { el.hidden = true; });
    openStudyVerseNum = block.number;
    panelEl.hidden = false;
    panelEl.classList.add('loading');
    panelEl.innerHTML = 'Loading word study…';

    try {
      const trans = BC.translationMeta(BC.getTranslationId());
      const study = await SC.loadVerseStudy({
        bookCode: currentBook.code,
        chapterNum: currentChapter,
        verseNum: block.number,
        english: block.text,
        bookName: chapterPayload.bookName,
        translationShort: trans.short || trans.id,
        chapterBlocks
      });
      renderStudyPanel(panelEl, study);
      panelEl.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    } catch (err) {
      panelEl.classList.remove('loading');
      panelEl.innerHTML = `<div class="reader-study-ref">Study unavailable</div><p>${escapeHtml(err.message || String(err))}</p>`;
    }
  }

  function handleVerseTap(block, blockEl, evt) {
    const tools = getTools();
    if (!tools.highlight && !tools.wordStudy) return;

    const verseEl = blockEl.querySelector('.reader-verse');
    if (!verseEl) return;

    // Multi-select highlight for share/copy (primary reading UX)
    if (tools.highlight) {
      toggleVerseSelection(block.number, evt);
      return;
    }

    // Highlight off: tap opens word study only
    if (tools.wordStudy) {
      openVerseStudy(block, blockEl);
    }
  }

  function categorizeVoices() {
    const voices = getVoices();
    const VP = window.VoicePicker;
    const savedId = AE && (AE.isHelloaoVoice(getVoiceId()) || AE.isPregenVoice(getVoiceId()))
      ? (localStorage.getItem('reader_last_system_voice') || '')
      : getVoiceId();
    if (VP) {
      return VP.categorizeEnglishVoices(voices, savedId, findVoiceByName);
    }
    const english = voices.filter((v) => (v.lang || '').toLowerCase().startsWith('en'));
    return { saved: findVoiceByName(savedId), personal: [], enhanced: [], grokStyle: [], other: english, all: english };
  }

  function cleanForSpeech(text) {
    return String(text || '').replace(/\s+/g, ' ').trim();
  }

  function speakText(text, onEnd) {
    const utterance = new SpeechSynthesisUtterance(cleanForSpeech(text));
    utterance.rate = parseFloat(localStorage.getItem('voice_rate') || '0.95');
    utterance.pitch = parseFloat(localStorage.getItem('voice_pitch') || '1');
    const voice = resolveSystemVoice();
    if (voice) utterance.voice = voice;
    utterance.onend = () => { if (onEnd) onEnd(); };
    utterance.onerror = (e) => {
      if (e.error !== 'canceled' && e.error !== 'interrupted' && onEnd) onEnd();
    };
    synth.speak(utterance);
    return utterance;
  }

  function currentTranslationId() {
    return BC.getTranslationId();
  }

  function usePregenAudio() {
    return AE && AE.isPregenVoice(getVoiceId());
  }

  function useHelloaoAudio() {
    return AE && getAudioMode() === 'helloao' && currentTranslationId() === 'BSB';
  }

  function helloaoChapterUrl() {
    if (!AE || !currentBook) return null;
    return AE.helloaoChapterUrl(
      currentTranslationId(),
      currentBook.code,
      currentChapter,
      AE.helloaoSlug(getVoiceId()),
      chapterAudioLinks
    );
  }

  function ensureDefaultVoice() {
    migrateAudioSettings();
    if (getVoiceId()) {
      updateAudioChrome();
      return;
    }
    if (getAudioMode() === 'helloao' && AE && currentTranslationId() === 'BSB') {
      setVoiceId(AE.toHelloaoVoiceId(localStorage.getItem('reader_last_helloao_voice') || 'david'));
    } else {
      const voice = resolveSystemVoice() || categorizeVoices().all[0];
      if (voice) setVoiceId(voice.name);
    }
    updateAudioChrome();
  }

  function clearHelloaoVoiceIfNeeded() {
    if (currentTranslationId() === 'BSB') return;
    if (getAudioMode() === 'helloao') {
      BC.saveReaderSettings({ audioMode: 'system' });
      setAudioMode('system');
    }
    updateAudioChrome();
  }

  function pregenVoiceSlug() {
    return AE ? AE.pregenSlug(getVoiceId()) : '';
  }

  function verseMp3Url(bookCode, chapter, verse) {
    if (!AE) return '';
    return AE.verseUrl(currentTranslationId(), pregenVoiceSlug(), bookCode, chapter, verse);
  }

  function playSpeech(text, onEnd) {
    audioMode = 'browser';
    speakText(text, onEnd);
  }

  function playVerseAudio(bookCode, chapter, verse, text, onEnd) {
    if (usePregenAudio() && currentBook) {
      const url = verseMp3Url(bookCode, chapter, verse);
      audioMode = 'mp3';
      AE.playMp3(url)
        .then(() => { if (onEnd) onEnd(); })
        .catch(() => playSpeech(text, onEnd));
      return;
    }
    playSpeech(text, onEnd);
  }

  function startHelloaoChapter() {
    const url = helloaoChapterUrl();
    if (!url || !AE) return false;

    stopAudio();
    audioPlaying = true;
    audioPaused = false;
    audioMode = 'helloao-chapter';
    els.btnPlay.textContent = '⏸';
    const narrator = AE.HELLOAO_BSB_NARRATORS.find((n) => n.slug === AE.helloaoSlug(getVoiceId()));
    els.audioLabel.textContent = narrator ? `${narrator.label} · chapter audio` : 'Playing chapter';

    AE.playMp3(url, {
      onTimeUpdate: (current, duration) => {
        els.audioProgress.style.width = `${(current / duration) * 100}%`;
      },
      onEnd: () => {
        stopAudio();
        els.audioLabel.textContent = 'Chapter complete';
      },
      onError: () => {
        els.audioLabel.textContent = 'Audio unavailable — try a system voice';
        stopAudio();
      }
    }).catch(() => {});

    return true;
  }

  function stopAudio() {
    synth.cancel();
    if (AE) AE.stopMp3();
    audioPlaying = false;
    audioPaused = false;
    audioMode = 'browser';
    audioQueue = [];
    audioIndex = 0;
    els.btnPlay.textContent = '▶';
    els.audioProgress.style.width = '0%';
    document.querySelectorAll('.reader-verse.active-audio').forEach((el) => el.classList.remove('active-audio'));
  }

  function buildAudioQueue() {
    const speakNumbers = BC.getReaderSettings().speakVerseNumbers;
    audioQueue = chapterBlocks
      .filter((b) => b.type === 'verse')
      .map((b) => ({
        number: b.number,
        text: speakNumbers ? `${b.number}. ${b.text}` : b.text,
        plain: b.text
      }));
  }

  function playNextInQueue() {
    if (!audioPlaying || audioPaused) return;
    if (audioIndex >= audioQueue.length) {
      stopAudio();
      els.audioLabel.textContent = 'Chapter complete';
      return;
    }
    const item = audioQueue[audioIndex];
    const pct = audioQueue.length ? ((audioIndex) / audioQueue.length) * 100 : 0;
    els.audioProgress.style.width = `${pct}%`;
    els.audioLabel.textContent = `Verse ${item.number} of ${audioQueue.length}`;

    document.querySelectorAll('.reader-verse.active-audio').forEach((el) => el.classList.remove('active-audio'));
    const verseEl = document.querySelector(`.reader-verse[data-verse="${item.number}"]`);
    if (verseEl) {
      verseEl.classList.add('active-audio');
      verseEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }

    const onDone = () => {
      audioIndex += 1;
      playNextInQueue();
    };

    if (usePregenAudio() && currentBook) {
      playVerseAudio(currentBook.code, currentChapter, item.number, item.text, onDone);
      return;
    }
    playSpeech(item.text, onDone);
  }

  function toggleAudio() {
    if (audioPlaying && !audioPaused) {
      if ((audioMode === 'mp3' || audioMode === 'helloao-chapter') && AE) {
        AE.pauseMp3();
      } else {
        synth.pause();
      }
      audioPaused = true;
      els.btnPlay.textContent = '▶';
      return;
    }
    if (audioPaused) {
      if ((audioMode === 'mp3' || audioMode === 'helloao-chapter') && AE) {
        AE.resumeMp3();
      } else {
        synth.resume();
      }
      audioPaused = false;
      els.btnPlay.textContent = '⏸';
      return;
    }
    if (!chapterBlocks.length) return;

    if (useHelloaoAudio() && startHelloaoChapter()) return;

    stopAudio();
    buildAudioQueue();
    audioPlaying = true;
    els.btnPlay.textContent = '⏸';
    playNextInQueue();
  }

  function applyReaderTypography() {
    const s = BC.getReaderSettings();
    const prose = document.getElementById('reader-prose');
    if (!prose) return;
    prose.className = 'reader-prose';
    prose.classList.add(`size-${s.fontSize || 'md'}`);
    prose.classList.add(`lh-${s.lineHeight || 'relaxed'}`);
  }

  async function loadChapter(book, chapter, verse) {
    currentBook = book;
    currentChapter = chapter;
    clearVerseSelection();
    stopAudio();
    BC.setRoute(book.code, chapter, verse);
    BC.saveProgress(book.code, chapter, verse || 1);

    els.headerBook.textContent = book.name;
    els.headerChapter.textContent = `Chapter ${chapter}`;
    els.scroll.innerHTML = '<div class="reader-status">Loading chapter…</div>';

    try {
      await BC.loadTranslationsCatalog();
      const payload = await BC.fetchChapter(book.code, chapter);
      chapterPayload = payload;
      chapterBlocks = BC.parseChapterContent(payload.chapter.content);
      chapterAudioLinks = payload.chapterAudioLinks || null;
      const tools = getTools();

      const prose = document.createElement('article');
      prose.id = 'reader-prose';
      prose.className = 'reader-prose size-md lh-relaxed';
      prose.innerHTML = `
        <div class="reader-free-badge">✦ Entire Bible · Free to read</div>
        <h2 class="reader-chapter-heading">${payload.bookName} ${chapter}</h2>
        <p class="reader-trans-label">${payload.translation}</p>
      `;

      chapterBlocks.forEach((block) => {
        if (block.type === 'heading') {
          const h = document.createElement('div');
          h.className = 'reader-section-heading';
          h.textContent = block.text;
          prose.appendChild(h);
          return;
        }
        const ref = `${payload.bookName} ${chapter}:${block.number}`;
        const blockEl = document.createElement('div');
        blockEl.className = 'reader-verse-block';
        blockEl.dataset.verse = String(block.number);

        const actionParts = [];
        if (tools.bookmark) {
          actionParts.push(`<button type="button" class="reader-verse-btn bookmark-btn" title="Bookmark" data-ref="${escapeAttr(ref)}" data-text="${escapeAttr(block.text)}">${BC.isBookmarked(ref) ? '★' : '☆'}</button>`);
        }
        if (tools.speaker) {
          actionParts.push(`<button type="button" class="reader-verse-btn speak-verse-btn" title="Speak verse" data-text="${escapeAttr(block.text)}">🔊</button>`);
        }
        // Quick share for this single verse
        actionParts.push(`<button type="button" class="reader-verse-btn share-verse-btn" title="Select & share" data-verse="${block.number}">↗</button>`);

        const tapClass = (tools.highlight || tools.wordStudy) ? ' tappable' : ' tappable';
        const actionsHtml = actionParts.length
          ? `<span class="reader-verse-actions">${actionParts.join('')}</span>`
          : '';

        blockEl.innerHTML = `
          <span class="reader-verse-wrap">
            <span class="reader-verse${tapClass}" data-verse="${block.number}" id="v${block.number}">
              <sup class="reader-verse-num">${block.number}</sup>
              <span class="reader-verse-text">${escapeHtml(block.text)}</span>
            </span>
            ${actionsHtml}
          </span>
          <div class="reader-study-panel" hidden></div>
        `;

        const verseEl = blockEl.querySelector('.reader-verse');
        if (verseEl) {
          verseEl.addEventListener('click', (e) => {
            if (e.target.closest('.reader-verse-btn')) return;
            // Always multi-select for copy/share while reading.
            // Word study is via the Study button on the selection bar (avoids conflict).
            if (tools.highlight !== false) {
              toggleVerseSelection(block.number, e);
            } else if (tools.wordStudy) {
              openVerseStudy(block, blockEl);
            } else {
              toggleVerseSelection(block.number, e);
            }
          });
        }

        prose.appendChild(blockEl);
      });

      const nav = document.createElement('div');
      nav.className = 'reader-chapter-nav';
      const prev = document.createElement('button');
      const books = BC.allBooks();
      const bookIdx = books.findIndex((b) => b.code === book.code);
      prev.textContent = chapter > 1 ? `← Chapter ${chapter - 1}` : '← Previous book';
      prev.disabled = chapter <= 1 && bookIdx <= 0;
      prev.addEventListener('click', () => navigateChapter(-1));

      const next = document.createElement('button');
      next.textContent = chapter < book.chapters ? `Chapter ${chapter + 1} →` : 'Next book →';
      next.addEventListener('click', () => navigateChapter(1));

      nav.appendChild(prev);
      nav.appendChild(next);
      prose.appendChild(nav);

      els.scroll.innerHTML = '';
      els.scroll.appendChild(prose);
      applyReaderTypography();

      prose.querySelectorAll('.bookmark-btn').forEach((btn) => {
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          const ref = btn.getAttribute('data-ref');
          const text = btn.getAttribute('data-text');
          if (BC.isBookmarked(ref)) {
            const bm = BC.getBookmarks().find((b) => b.ref === ref);
            if (bm) BC.removeBookmark(bm.id);
            btn.textContent = '☆';
          } else {
            BC.addBookmark(ref, text);
            btn.textContent = '★';
          }
        });
      });

      prose.querySelectorAll('.speak-verse-btn').forEach((btn) => {
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          stopAudio();
          const verseNum = Number(btn.closest('.reader-verse-wrap')?.querySelector('.reader-verse')?.getAttribute('data-verse'));
          const text = btn.getAttribute('data-text');
          if (currentBook && verseNum) {
            playVerseAudio(currentBook.code, currentChapter, verseNum, text);
          } else {
            playSpeech(text);
          }
        });
      });

      prose.querySelectorAll('.share-verse-btn').forEach((btn) => {
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          const verseNum = Number(btn.getAttribute('data-verse'));
          if (!verseNum) return;
          if (!selectedVerses.has(verseNum)) {
            selectedVerses.add(verseNum);
            lastTappedVerse = verseNum;
            renderSelectionHighlights();
            updateSelectionBar();
          }
          openReaderShareMenu(btn);
        });
      });

      // Restore highlight classes if user navigated within same chapter selection (usually empty)
      renderSelectionHighlights();
      updateSelectionBar();

      if (verse) {
        const target = document.getElementById(`v${verse}`);
        if (target) setTimeout(() => target.scrollIntoView({ behavior: 'smooth', block: 'center' }), 200);
      }

      els.continueWrap.hidden = true;
      updateAudioChrome();
    } catch (err) {
      els.scroll.innerHTML = `<div class="reader-status error">Could not load this chapter.<br><small>${escapeHtml(err.message || String(err))}</small></div>`;
    }
  }

  function navigateChapter(delta) {
    if (!currentBook) return;
    let ch = currentChapter + delta;
    let book = currentBook;
    if (ch < 1) {
      const books = BC.allBooks();
      const idx = books.findIndex((b) => b.code === book.code);
      if (idx > 0) {
        book = books[idx - 1];
        ch = book.chapters;
      } else return;
    } else if (ch > book.chapters) {
      const books = BC.allBooks();
      const idx = books.findIndex((b) => b.code === book.code);
      if (idx < books.length - 1) {
        book = books[idx + 1];
        ch = 1;
      } else return;
    }
    loadChapter(book, ch, null);
    els.main.scrollTop = 0;
  }

  function openNav(tab) {
    sheetTab = tab || 'books';
    els.overlay.classList.add('open');
    els.sheet.classList.add('open');
    els.sheet.setAttribute('aria-hidden', 'false');
    renderNavBody();
    updateNavTabs();
  }

  function closeNav() {
    els.overlay.classList.remove('open');
    els.sheet.classList.remove('open');
    els.sheet.setAttribute('aria-hidden', 'true');
  }

  function updateNavTabs() {
    document.querySelectorAll('.nav-tab').forEach((t) => {
      const name = t.getAttribute('data-tab');
      t.classList.toggle('active', name === sheetTab);
    });
    const tabCh = document.getElementById('tab-chapters');
    if (tabCh) tabCh.disabled = !navBook;
  }

  function renderNavBody() {
    const body = els.navBody;
    if (!body) return;

    if (sheetTab === 'books') {
      const q = body.querySelector('.nav-search')?.value || '';
      body.innerHTML = `<input type="search" class="nav-search" placeholder="Search books…" value="${escapeAttr(q)}">`;
      const search = body.querySelector('.nav-search');
      search.addEventListener('input', () => renderNavBody());

      const filter = (books) => {
        const term = search.value.trim().toLowerCase();
        return term ? books.filter((b) => b.name.toLowerCase().includes(term)) : books;
      };

      ['Old Testament', 'New Testament'].forEach((label, i) => {
        const list = filter(i === 0 ? BC.BIBLE_BOOKS.ot : BC.BIBLE_BOOKS.nt);
        if (!list.length) return;
        const sec = document.createElement('div');
        sec.innerHTML = `<div class="nav-section-label">${label}</div>`;
        const grid = document.createElement('div');
        grid.className = 'nav-books-grid';
        list.forEach((book) => {
          const btn = document.createElement('button');
          btn.type = 'button';
          btn.className = 'nav-book-btn' + (navBook && navBook.code === book.code ? ' active' : '');
          btn.textContent = book.name;
          btn.addEventListener('click', () => {
            navBook = book;
            sheetTab = 'chapters';
            renderNavBody();
            updateNavTabs();
          });
          grid.appendChild(btn);
        });
        sec.appendChild(grid);
        body.appendChild(sec);
      });
      return;
    }

    if (sheetTab === 'chapters' && navBook) {
      body.innerHTML = `<div class="nav-section-label">${navBook.name}</div>`;
      const grid = document.createElement('div');
      grid.className = 'nav-chapters-grid';
      for (let c = 1; c <= navBook.chapters; c++) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'nav-chapter-btn' + (currentBook && currentBook.code === navBook.code && currentChapter === c ? ' active' : '');
        btn.textContent = String(c);
        btn.addEventListener('click', () => {
          closeNav();
          loadChapter(navBook, c, null);
          els.main.scrollTop = 0;
        });
        grid.appendChild(btn);
      }
      body.appendChild(grid);
      return;
    }

    if (sheetTab === 'bookmarks') {
      const bookmarks = BC.getBookmarks();
      if (!bookmarks.length) {
        body.innerHTML = '<p class="reader-voice-hint" style="padding:12px">Tap ☆ on any verse to save it here.</p>';
        return;
      }
      body.innerHTML = '';
      bookmarks.forEach((bm) => {
        const item = document.createElement('div');
        item.className = 'bookmark-item';
        item.innerHTML = `
          <div style="flex:1;min-width:0">
            <div class="bookmark-ref">${escapeHtml(bm.ref)}</div>
            <div class="bookmark-text">${escapeHtml(bm.text)}</div>
          </div>
          <button type="button" class="bookmark-remove" aria-label="Remove">×</button>
        `;
        item.addEventListener('click', () => {
          const m = bm.ref.match(/^(.+?)\s+(\d+):(\d+)/);
          if (m) {
            const book = BC.findBook(m[1]);
            if (book) {
              closeNav();
              loadChapter(book, parseInt(m[2], 10), parseInt(m[3], 10));
            }
          }
        });
        item.querySelector('.bookmark-remove').addEventListener('click', (e) => {
          e.stopPropagation();
          BC.removeBookmark(bm.id);
          renderNavBody();
        });
        body.appendChild(item);
      });
      return;
    }

    if (sheetTab === 'settings') {
      const s = BC.getReaderSettings();
      const tools = getTools();
      const cats = categorizeVoices();
      const transId = currentTranslationId();
      const audioMode = getAudioMode();
      const speakNumbers = BC.getReaderSettings().speakVerseNumbers;
      const pregenVoices = AE ? AE.availablePregenVoices(transId) : [];
      const catalogVoices = AE ? AE.allCatalogVoices() : [];
      const showCatalog = catalogVoices.length > 0;
      body.innerHTML = `
        <div class="reader-settings-group">
          <div class="reader-settings-label">Reading tools</div>
          <div class="reader-tool-toggles">
            <div class="reader-tool-row">
              <label for="tool-speaker">Speaker (🔊 per verse)</label>
              <input type="checkbox" id="tool-speaker" ${tools.speaker ? 'checked' : ''}>
            </div>
            <div class="reader-tool-row">
              <label for="tool-bookmark">Bookmarks (★)</label>
              <input type="checkbox" id="tool-bookmark" ${tools.bookmark ? 'checked' : ''}>
            </div>
            <div class="reader-tool-row">
              <label for="tool-highlight">Select verses (tap to share/copy)</label>
              <input type="checkbox" id="tool-highlight" ${tools.highlight ? 'checked' : ''}>
            </div>
            <div class="reader-tool-row">
              <label for="tool-word-study">Word study (Study button)</label>
              <input type="checkbox" id="tool-word-study" ${tools.wordStudy ? 'checked' : ''}>
            </div>
          </div>
          <a href="/app?view=library" class="reader-library-link">Open full Library study mode →</a>
          <p class="reader-voice-hint">Tap one or more verses to highlight them, then <strong>Copy</strong> or <strong>Share</strong>. Share as <strong>text</strong> (Messages/Facebook) or create a <strong>voice video</strong> that reads the verses aloud for social posts. Shift-tap selects a range on desktop. Use <strong>Study</strong> for Greek/Hebrew on a single selected verse.</p>
        </div>
        <div class="reader-settings-group">
          <div class="reader-settings-label">Text size</div>
          <div class="reader-pill-row" id="font-size-pills">
            ${['sm', 'md', 'lg', 'xl'].map((sz) => `<button type="button" class="reader-pill${s.fontSize === sz ? ' active' : ''}" data-size="${sz}">${sz.toUpperCase()}</button>`).join('')}
          </div>
        </div>
        <div class="reader-settings-group">
          <div class="reader-settings-label">Line spacing</div>
          <div class="reader-pill-row" id="line-pills">
            ${[['normal', 'Normal'], ['relaxed', 'Relaxed'], ['loose', 'Loose']].map(([k, l]) => `<button type="button" class="reader-pill${(s.lineHeight || 'relaxed') === k ? ' active' : ''}" data-lh="${k}">${l}</button>`).join('')}
          </div>
        </div>
        <div class="reader-settings-group">
          <div class="reader-settings-label">Audio source</div>
          ${transId === 'BSB' ? `
          <div class="reader-pill-row" id="audio-mode-pills">
            <button type="button" class="reader-pill${audioMode === 'helloao' ? ' active' : ''}" data-audio-mode="helloao">BSB Audio</button>
            <button type="button" class="reader-pill${audioMode === 'system' ? ' active' : ''}" data-audio-mode="system">Device voice</button>
          </div>
          <p class="reader-voice-hint" style="margin-top:8px">Now: <strong>${escapeHtml(voiceModeLabel())}</strong> — tap ▶ for chapter; 🔊 uses device voice unless BSB Audio is on.</p>
          ` : '<p class="reader-voice-hint">BSB Audio is only for Berean Standard Bible. Other translations use your device voice.</p>'}
        </div>
        <div class="reader-settings-group">
          <div class="reader-settings-label">Narration voice</div>
          <select class="reader-voice-select" id="voice-select-reader"></select>
          <button type="button" class="reader-pill" id="btn-refresh-voices" style="margin-top:8px;width:100%">Refresh device voices</button>
          <div class="reader-tool-toggles" style="margin-top:10px">
            <div class="reader-tool-row">
              <label for="tool-speak-numbers">Speak verse numbers (device voice)</label>
              <input type="checkbox" id="tool-speak-numbers" ${speakNumbers ? 'checked' : ''}>
            </div>
          </div>
          <p class="reader-voice-hint">${transId === 'BSB' ? '<strong>BSB Audio</strong> — whole chapter MP3 (David, Hays, Souer).<br>' : ''}${showCatalog ? '<strong>Studio voices</strong> — pre-generated narration.<br>' : ''}<strong>Device voices</strong> — per-verse 🔊 and non-BSB chapters.</p>
        </div>
      `;

      const sel = body.querySelector('#voice-select-reader');
      const currentVoice = getVoiceId();

      if (transId === 'BSB' && AE && audioMode === 'helloao') {
        const og = document.createElement('optgroup');
        og.label = '— BSB Audio (free) —';
        AE.HELLOAO_BSB_NARRATORS.forEach((n) => {
          const opt = document.createElement('option');
          const voiceId = AE.toHelloaoVoiceId(n.slug);
          opt.value = voiceId;
          opt.textContent = n.label;
          if (voiceId === currentVoice) opt.selected = true;
          og.appendChild(opt);
        });
        sel.appendChild(og);
      }

      if (pregenVoices.length) {
        const og = document.createElement('optgroup');
        og.label = `— Studio (${transId}) —`;
        pregenVoices.forEach((v) => {
          const opt = document.createElement('option');
          const voiceId = AE.toPregenVoiceId(v.slug);
          opt.value = voiceId;
          const avail = AE.availabilityFor(transId, v.slug);
          const countLabel = avail && avail.verseCount ? ` · ${avail.verseCount.toLocaleString()} verses` : '';
          opt.textContent = `${v.label}${countLabel}`;
          if (voiceId === currentVoice) opt.selected = true;
          og.appendChild(opt);
        });
        sel.appendChild(og);
      } else if (showCatalog) {
        const og = document.createElement('optgroup');
        og.label = '— Studio (generate audio to enable) —';
        catalogVoices.forEach((v) => {
          const opt = document.createElement('option');
          opt.value = AE.toPregenVoiceId(v.slug);
          opt.textContent = v.label;
          opt.disabled = true;
          og.appendChild(opt);
        });
        sel.appendChild(og);
      }

      if (audioMode === 'system' || transId !== 'BSB') {
        const groups = [
          ['— Your saved voice —', cats.saved ? [cats.saved] : []],
          ['— Personal / Cloned —', cats.personal],
          ['— Premium Neural —', cats.enhanced],
          ['— John (Narrator) —', cats.grokStyle],
          ['— All English voices —', cats.other]
        ];
        groups.forEach(([label, list]) => {
          if (!list.length) return;
          const og = document.createElement('optgroup');
          og.label = label;
          list.forEach((v) => {
            const opt = document.createElement('option');
            opt.value = v.name;
            opt.textContent = v.name;
            if (v.name === currentVoice || (AE && (AE.isHelloaoVoice(currentVoice) || AE.isPregenVoice(currentVoice)) && v === cats.saved)) {
              opt.selected = true;
            }
            og.appendChild(opt);
          });
          sel.appendChild(og);
        });
        if (!sel.options.length && cats.all.length) {
          cats.all.forEach((v) => {
            const opt = document.createElement('option');
            opt.value = v.name;
            opt.textContent = v.name;
            sel.appendChild(opt);
          });
        }
      }

      sel.addEventListener('change', () => {
        const val = sel.value;
        setVoiceId(val);
        if (AE && AE.isHelloaoVoice(val) && transId === 'BSB') {
          BC.saveReaderSettings({ audioMode: 'helloao' });
          updateAudioChrome();
        } else if (!AE || (!AE.isPregenVoice(val))) {
          BC.saveReaderSettings({ audioMode: 'system' });
          updateAudioChrome();
        }
      });

      body.querySelectorAll('[data-audio-mode]').forEach((btn) => {
        btn.addEventListener('click', () => setAudioMode(btn.getAttribute('data-audio-mode')));
      });

      const refreshBtn = body.querySelector('#btn-refresh-voices');
      if (refreshBtn) refreshBtn.addEventListener('click', refreshSystemVoices);

      const speakNumInput = body.querySelector('#tool-speak-numbers');
      if (speakNumInput) {
        speakNumInput.addEventListener('change', () => {
          BC.saveReaderSettings({ speakVerseNumbers: speakNumInput.checked });
        });
      }

      const saveTools = () => {
        BC.saveReaderSettings({
          tools: {
            speaker: !!body.querySelector('#tool-speaker')?.checked,
            bookmark: !!body.querySelector('#tool-bookmark')?.checked,
            highlight: !!body.querySelector('#tool-highlight')?.checked,
            wordStudy: !!body.querySelector('#tool-word-study')?.checked
          }
        });
        const keepVerse = sortedSelectedVerses()[0] || null;
        if (currentBook) loadChapter(currentBook, currentChapter, keepVerse);
      };
      ['#tool-speaker', '#tool-bookmark', '#tool-highlight', '#tool-word-study'].forEach((selId) => {
        const input = body.querySelector(selId);
        if (input) input.addEventListener('change', saveTools);
      });

      body.querySelectorAll('[data-size]').forEach((btn) => {
        btn.addEventListener('click', () => {
          BC.saveReaderSettings({ fontSize: btn.getAttribute('data-size') });
          applyReaderTypography();
          renderNavBody();
        });
      });
      body.querySelectorAll('[data-lh]').forEach((btn) => {
        btn.addEventListener('click', () => {
          BC.saveReaderSettings({ lineHeight: btn.getAttribute('data-lh') });
          applyReaderTypography();
          renderNavBody();
        });
      });
    }
  }

  async function populateTranslations() {
    await BC.loadTranslationsCatalog();
    const lang = BC.getReadingLang();
    const options = lang === 'eng' ? BC.ENGLISH_TRANS : BC.translationsForLang(lang);
    const current = BC.getTranslationId();
    els.navTrans.innerHTML = '';
    (options.length ? options : BC.ENGLISH_TRANS).forEach((t) => {
      const opt = document.createElement('option');
      opt.value = t.id;
      opt.textContent = t.name;
      if (t.id === current) opt.selected = true;
      els.navTrans.appendChild(opt);
    });
  }

  function showContinueIfNeeded(route) {
    const progress = BC.getProgress();
    if (!progress || !progress.bookCode) return;
    const book = BC.findBook(progress.bookCode);
    if (!book) return;
    if (route.book.code === progress.bookCode && route.chapter === progress.chapter) return;
    els.continueRef.textContent = `${book.name} ${progress.chapter}`;
    els.continueWrap.hidden = false;
    els.continueCard.onclick = () => {
      els.continueWrap.hidden = true;
      loadChapter(book, progress.chapter, progress.verse);
    };
  }

  function setupScrollChrome() {
    els.main.addEventListener('scroll', () => {
      const y = els.main.scrollTop;
      if (y > lastScrollY + 8 && y > 80) {
        els.header.classList.add('hidden-chrome');
        els.audioBar.classList.add('hidden-chrome');
      } else if (y < lastScrollY - 8) {
        els.header.classList.remove('hidden-chrome');
        els.audioBar.classList.remove('hidden-chrome');
      }
      lastScrollY = y;
      clearTimeout(scrollHideTimer);
      scrollHideTimer = setTimeout(() => {
        els.header.classList.remove('hidden-chrome');
        els.audioBar.classList.remove('hidden-chrome');
      }, 2400);
    }, { passive: true });
  }

  function bindEvents() {
    document.getElementById('btn-nav').addEventListener('click', () => openNav('books'));
    document.getElementById('btn-title').addEventListener('click', () => openNav(navBook ? 'chapters' : 'books'));
    document.getElementById('btn-close-nav').addEventListener('click', closeNav);
    els.overlay.addEventListener('click', closeNav);
    document.getElementById('btn-theme').addEventListener('click', () => {
      localStorage.setItem('dark_mode', isDark() ? 'false' : 'true');
      applyTheme();
    });
    document.getElementById('btn-settings').addEventListener('click', () => openNav('settings'));
    document.getElementById('btn-voice-picker').addEventListener('click', () => openNav('settings'));
    els.btnPlay.addEventListener('click', toggleAudio);
    if (els.btnAudioMode) els.btnAudioMode.addEventListener('click', toggleAudioMode);

    document.querySelectorAll('.nav-tab').forEach((tab) => {
      tab.addEventListener('click', () => {
        if (tab.disabled) return;
        sheetTab = tab.getAttribute('data-tab');
        renderNavBody();
        updateNavTabs();
      });
    });

    els.navTrans.addEventListener('change', async () => {
      BC.setTranslationId(els.navTrans.value);
      clearHelloaoVoiceIfNeeded();
      ensureDefaultVoice();
      if (currentBook) await loadChapter(currentBook, currentChapter, null);
    });

    window.addEventListener('hashchange', () => {
      const route = BC.parseRoute();
      if (route.book && (route.book.code !== currentBook?.code || route.chapter !== currentChapter)) {
        loadChapter(route.book, route.chapter, route.verse);
      }
    });

    if (synth.onvoiceschanged !== undefined) {
      synth.onvoiceschanged = () => {
        if (sheetTab === 'settings') renderNavBody();
        updateAudioChrome();
      };
    }
    try { synth.getVoices(); } catch (e) {}
  }

  async function init() {
    applyTheme();
    bindEvents();
    setupScrollChrome();
    // Voice-video feature flags (admin toggle)
    fetch('/api/config').then((r) => r.json()).then((cfg) => {
      if (cfg && cfg.shareTts) window.__shareTtsConfig = cfg.shareTts;
    }).catch(() => {
      window.__shareTtsConfig = { enabled: true };
    });
    if (AE) {
      await AE.loadCatalog().catch(() => {});
      audioCatalogLoaded = true;
    }
    await populateTranslations();
    ensureDefaultVoice();
    BC.loadCompleteBible().catch(() => {});

    const route = BC.parseRoute();
    navBook = route.book;
    showContinueIfNeeded(route);
    await loadChapter(route.book, route.chapter, route.verse);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();