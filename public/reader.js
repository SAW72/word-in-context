(function () {
  'use strict';

  const BC = window.BibleCore;
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
  let scrollHideTimer = null;
  let lastScrollY = 0;

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

  function categorizeVoices() {
    const voices = getVoices().filter((v) => (v.lang || '').toLowerCase().startsWith('en'));
    const saved = findVoiceByName(getVoiceId());
    const personal = voices.filter((v) => /personal|cloned/i.test(v.name));
    const enhanced = voices.filter((v) => /enhanced|premium|neural|google uk|google us/i.test(v.name));
    const grokStyle = voices.filter((v) =>
      /daniel|samantha|alex|karen|fred|aaron|nicky/i.test(v.name) && !enhanced.includes(v)
    );
    const used = new Set([saved, ...personal, ...enhanced, ...grokStyle].filter(Boolean));
    const other = voices.filter((v) => !used.has(v));
    return { saved, personal, enhanced, grokStyle, other, all: voices };
  }

  function cleanForSpeech(text) {
    return String(text || '').replace(/\s+/g, ' ').trim();
  }

  function speakText(text, onEnd) {
    const utterance = new SpeechSynthesisUtterance(cleanForSpeech(text));
    utterance.rate = parseFloat(localStorage.getItem('voice_rate') || '0.95');
    utterance.pitch = parseFloat(localStorage.getItem('voice_pitch') || '1');
    const voice = findVoiceByName(getVoiceId());
    if (voice) utterance.voice = voice;
    utterance.onend = () => { if (onEnd) onEnd(); };
    utterance.onerror = (e) => {
      if (e.error !== 'canceled' && e.error !== 'interrupted' && onEnd) onEnd();
    };
    synth.speak(utterance);
    return utterance;
  }

  function stopAudio() {
    synth.cancel();
    audioPlaying = false;
    audioPaused = false;
    audioQueue = [];
    audioIndex = 0;
    els.btnPlay.textContent = '▶';
    els.audioProgress.style.width = '0%';
    document.querySelectorAll('.reader-verse.active-audio').forEach((el) => el.classList.remove('active-audio'));
  }

  function buildAudioQueue() {
    audioQueue = chapterBlocks
      .filter((b) => b.type === 'verse')
      .map((b) => ({ number: b.number, text: `${b.number}. ${b.text}` }));
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

    speakText(item.text, () => {
      audioIndex += 1;
      playNextInQueue();
    });
  }

  function toggleAudio() {
    if (audioPlaying && !audioPaused) {
      synth.pause();
      audioPaused = true;
      els.btnPlay.textContent = '▶';
      return;
    }
    if (audioPaused) {
      synth.resume();
      audioPaused = false;
      els.btnPlay.textContent = '⏸';
      return;
    }
    if (!chapterBlocks.length) return;
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
    stopAudio();
    BC.setRoute(book.code, chapter, verse);
    BC.saveProgress(book.code, chapter, verse || 1);

    els.headerBook.textContent = book.name;
    els.headerChapter.textContent = `Chapter ${chapter}`;
    els.scroll.innerHTML = '<div class="reader-status">Loading chapter…</div>';

    try {
      await BC.loadTranslationsCatalog();
      const payload = await BC.fetchChapter(book.code, chapter);
      chapterBlocks = BC.parseChapterContent(payload.chapter.content);

      const prose = document.createElement('article');
      prose.id = 'reader-prose';
      prose.className = 'reader-prose size-md lh-relaxed';
      prose.innerHTML = `
        <div class="reader-free-badge">✦ Entire Bible · Free to read</div>
        <h1 class="reader-chapter-heading">${payload.bookName} ${chapter}</h1>
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
        const wrap = document.createElement('span');
        wrap.className = 'reader-verse-wrap';
        wrap.innerHTML = `
          <span class="reader-verse" data-verse="${block.number}" id="v${block.number}">
            <sup class="reader-verse-num">${block.number}</sup>
            <span class="reader-verse-text">${escapeHtml(block.text)}</span>
          </span>
          <span class="reader-verse-actions">
            <button type="button" class="reader-verse-btn bookmark-btn" title="Bookmark" data-ref="${escapeAttr(ref)}" data-text="${escapeAttr(block.text)}">${BC.isBookmarked(ref) ? '★' : '☆'}</button>
            <button type="button" class="reader-verse-btn speak-verse-btn" title="Speak verse" data-text="${escapeAttr(block.text)}">🔊</button>
          </span>
        `;
        prose.appendChild(wrap);
        prose.appendChild(document.createTextNode(' '));
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
          speakText(btn.getAttribute('data-text'));
        });
      });

      if (verse) {
        const target = document.getElementById(`v${verse}`);
        if (target) setTimeout(() => target.scrollIntoView({ behavior: 'smooth', block: 'center' }), 200);
      }

      els.continueWrap.hidden = true;
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

  function escapeHtml(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function escapeAttr(s) {
    return escapeHtml(s).replace(/'/g, '&#39;');
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
      const cats = categorizeVoices();
      body.innerHTML = `
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
          <div class="reader-settings-label">Narration voice</div>
          <select class="reader-voice-select" id="voice-select-reader"></select>
          <p class="reader-voice-hint"><strong>Your Voice</strong> — saved from app Settings or Personal Voice on Mac.<br><strong>Premium Neural</strong> — Enhanced system voices (Chrome recommended).<br><strong>John (Narrator)</strong> — clear English voices tuned for Scripture.</p>
        </div>
      `;

      const sel = body.querySelector('#voice-select-reader');
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
          if (v.name === getVoiceId()) opt.selected = true;
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
      sel.addEventListener('change', () => setVoiceId(sel.value));

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
      if (currentBook) await loadChapter(currentBook, currentChapter, null);
    });

    window.addEventListener('hashchange', () => {
      const route = BC.parseRoute();
      if (route.book && (route.book.code !== currentBook?.code || route.chapter !== currentChapter)) {
        loadChapter(route.book, route.chapter, route.verse);
      }
    });

    if (synth.onvoiceschanged !== undefined) {
      synth.onvoiceschanged = () => { /* voice list refresh */ };
    }
    try { synth.getVoices(); } catch (e) {}
  }

  async function init() {
    applyTheme();
    bindEvents();
    setupScrollChrome();
    await populateTranslations();
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