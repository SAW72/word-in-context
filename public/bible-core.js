/**
 * Shared Bible data layer — free public-domain text via bible.helloao.org
 */
(function (global) {
  'use strict';

  const BIBLE_API_ORIGIN = 'https://bible.helloao.org';

  const BIBLE_BOOKS = {
    ot: [
      { name: 'Genesis', code: 'GEN', chapters: 50 },
      { name: 'Exodus', code: 'EXO', chapters: 40 },
      { name: 'Leviticus', code: 'LEV', chapters: 27 },
      { name: 'Numbers', code: 'NUM', chapters: 36 },
      { name: 'Deuteronomy', code: 'DEU', chapters: 34 },
      { name: 'Joshua', code: 'JOS', chapters: 24 },
      { name: 'Judges', code: 'JDG', chapters: 21 },
      { name: 'Ruth', code: 'RUT', chapters: 4 },
      { name: '1 Samuel', code: '1SA', chapters: 31 },
      { name: '2 Samuel', code: '2SA', chapters: 24 },
      { name: '1 Kings', code: '1KI', chapters: 22 },
      { name: '2 Kings', code: '2KI', chapters: 25 },
      { name: '1 Chronicles', code: '1CH', chapters: 29 },
      { name: '2 Chronicles', code: '2CH', chapters: 36 },
      { name: 'Ezra', code: 'EZR', chapters: 10 },
      { name: 'Nehemiah', code: 'NEH', chapters: 13 },
      { name: 'Esther', code: 'EST', chapters: 10 },
      { name: 'Job', code: 'JOB', chapters: 42 },
      { name: 'Psalms', code: 'PSA', chapters: 150 },
      { name: 'Proverbs', code: 'PRO', chapters: 31 },
      { name: 'Ecclesiastes', code: 'ECC', chapters: 12 },
      { name: 'Song of Solomon', code: 'SNG', chapters: 8 },
      { name: 'Isaiah', code: 'ISA', chapters: 66 },
      { name: 'Jeremiah', code: 'JER', chapters: 52 },
      { name: 'Lamentations', code: 'LAM', chapters: 5 },
      { name: 'Ezekiel', code: 'EZE', chapters: 48 },
      { name: 'Daniel', code: 'DAN', chapters: 12 },
      { name: 'Hosea', code: 'HOS', chapters: 14 },
      { name: 'Joel', code: 'JOL', chapters: 3 },
      { name: 'Amos', code: 'AMO', chapters: 9 },
      { name: 'Obadiah', code: 'OBA', chapters: 1 },
      { name: 'Jonah', code: 'JON', chapters: 4 },
      { name: 'Micah', code: 'MIC', chapters: 7 },
      { name: 'Nahum', code: 'NAM', chapters: 3 },
      { name: 'Habakkuk', code: 'HAB', chapters: 3 },
      { name: 'Zephaniah', code: 'ZEP', chapters: 3 },
      { name: 'Haggai', code: 'HAG', chapters: 2 },
      { name: 'Zechariah', code: 'ZEC', chapters: 14 },
      { name: 'Malachi', code: 'MAL', chapters: 4 }
    ],
    nt: [
      { name: 'Matthew', code: 'MAT', chapters: 28 },
      { name: 'Mark', code: 'MRK', chapters: 16 },
      { name: 'Luke', code: 'LUK', chapters: 24 },
      { name: 'John', code: 'JHN', chapters: 21 },
      { name: 'Acts', code: 'ACT', chapters: 28 },
      { name: 'Romans', code: 'ROM', chapters: 16 },
      { name: '1 Corinthians', code: '1CO', chapters: 16 },
      { name: '2 Corinthians', code: '2CO', chapters: 13 },
      { name: 'Galatians', code: 'GAL', chapters: 6 },
      { name: 'Ephesians', code: 'EPH', chapters: 6 },
      { name: 'Philippians', code: 'PHP', chapters: 4 },
      { name: 'Colossians', code: 'COL', chapters: 4 },
      { name: '1 Thessalonians', code: '1TH', chapters: 5 },
      { name: '2 Thessalonians', code: '2TH', chapters: 3 },
      { name: '1 Timothy', code: '1TI', chapters: 6 },
      { name: '2 Timothy', code: '2TI', chapters: 4 },
      { name: 'Titus', code: 'TIT', chapters: 3 },
      { name: 'Philemon', code: 'PHM', chapters: 1 },
      { name: 'Hebrews', code: 'HEB', chapters: 13 },
      { name: 'James', code: 'JAS', chapters: 5 },
      { name: '1 Peter', code: '1PE', chapters: 5 },
      { name: '2 Peter', code: '2PE', chapters: 3 },
      { name: '1 John', code: '1JN', chapters: 5 },
      { name: '2 John', code: '2JN', chapters: 1 },
      { name: '3 John', code: '3JN', chapters: 1 },
      { name: 'Jude', code: 'JUD', chapters: 1 },
      { name: 'Revelation', code: 'REV', chapters: 22 }
    ]
  };

  const ENGLISH_TRANS = [
    { id: 'BSB', name: 'Berean Standard Bible', short: 'BSB' },
    { id: 'eng_kjv', name: 'King James Version', short: 'KJV' },
    { id: 'eng_net', name: 'NET Bible', short: 'NET' },
    { id: 'eng_dby', name: 'Darby Translation', short: 'DBY' },
    { id: 'eng_asv', name: 'American Standard Version', short: 'ASV' },
    { id: 'eng_ylt', name: "Young's Literal Translation", short: 'YLT' },
    { id: 'ENGWEBP', name: 'World English Bible', short: 'WEB' }
  ];

  const LANG_OPTIONS = [
    { code: 'eng', name: 'English' },
    { code: 'spa', name: 'Spanish' },
    { code: 'fra', name: 'French' },
    { code: 'deu', name: 'German' },
    { code: 'por', name: 'Portuguese' },
    { code: 'cmn', name: 'Chinese' },
    { code: 'kor', name: 'Korean' },
    { code: 'jpn', name: 'Japanese' },
    { code: 'rus', name: 'Russian' },
    { code: 'ita', name: 'Italian' },
    { code: 'nld', name: 'Dutch' },
    { code: 'pol', name: 'Polish' },
    { code: 'hin', name: 'Hindi' },
    { code: 'vie', name: 'Vietnamese' },
    { code: 'ind', name: 'Indonesian' },
    { code: 'tgl', name: 'Tagalog' },
    { code: 'ukr', name: 'Ukrainian' },
    { code: 'heb', name: 'Hebrew' },
    { code: 'swh', name: 'Swahili' }
  ];

  const LANG_DEFAULT_TRANS = {
    eng: 'BSB', spa: 'spa_r09', fra: 'fra_lsg', deu: 'deu_l12', por: 'por_blj',
    cmn: 'cmn_cu1', kor: 'kor_old', jpn: 'jpn_loc', rus: 'rus_syn', ita: 'ita_riv',
    nld: 'nld_nbg', pol: 'pol_ubg', hin: 'HINIRV', vie: 'vie_vcb', ind: 'ind_ayt',
    tgl: 'tgl_ulb', ukr: 'ukr_ufb', heb: 'heb_mod', swh: 'swh_bib'
  };

  const completeCache = {};
  const completePromises = {};
  let translationsCatalog = null;
  let translationsPromise = null;

  function allBooks() {
    return [...BIBLE_BOOKS.ot, ...BIBLE_BOOKS.nt];
  }

  function findBook(codeOrName) {
    const q = String(codeOrName || '').trim();
    if (!q) return null;
    const upper = q.toUpperCase();
    return allBooks().find((b) => b.code === upper || b.name.toLowerCase() === q.toLowerCase()) || null;
  }

  function bibleContentPartText(part) {
    if (!part) return '';
    if (typeof part === 'string') return part;
    if (part.text) return part.text;
    if (part.lineBreak) return ' ';
    if (Array.isArray(part.words)) return part.words.map((w) => w.text || '').join(' ');
    return '';
  }

  function parseChapterContent(content) {
    const blocks = [];
    if (!Array.isArray(content)) return blocks;
    for (const item of content) {
      if (item.type === 'heading' && Array.isArray(item.content)) {
        blocks.push({ type: 'heading', text: item.content.map(bibleContentPartText).join(' ').trim() });
      } else if (item.type === 'verse' && typeof item.number === 'number') {
        const text = (item.content || []).map(bibleContentPartText).join(' ').replace(/\s+/g, ' ').trim();
        if (text) blocks.push({ type: 'verse', number: item.number, text });
      }
    }
    return blocks;
  }

  function getReadingLang() {
    return localStorage.getItem('library_reading_lang') || 'eng';
  }

  function setReadingLang(code) {
    localStorage.setItem('library_reading_lang', code);
  }

  function getTranslationId() {
    const saved = localStorage.getItem('library_reading_trans')
      || localStorage.getItem('library_english_trans')
      || 'BSB';
    return saved;
  }

  function setTranslationId(id) {
    localStorage.setItem('library_reading_trans', id);
  }

  async function loadTranslationsCatalog() {
    if (translationsCatalog) return translationsCatalog;
    if (translationsPromise) return translationsPromise;
    translationsPromise = fetch(`${BIBLE_API_ORIGIN}/api/available_translations.json`)
      .then((r) => r.json())
      .then((data) => {
        translationsCatalog = data;
        return data;
      })
      .catch((err) => {
        translationsPromise = null;
        throw err;
      });
    return translationsPromise;
  }

  function translationsForLang(langCode) {
    if (!translationsCatalog || !Array.isArray(translationsCatalog.translations)) {
      return langCode === 'eng' ? ENGLISH_TRANS : [];
    }
    return translationsCatalog.translations
      .filter((t) => t.language === langCode)
      .map((t) => ({
        id: t.id,
        name: t.englishName || t.name || t.id,
        short: t.shortName || t.id
      }));
  }

  function translationMeta(id) {
    const fromEng = ENGLISH_TRANS.find((t) => t.id === id);
    if (fromEng) return fromEng;
    if (translationsCatalog && Array.isArray(translationsCatalog.translations)) {
      const t = translationsCatalog.translations.find((x) => x.id === id);
      if (t) return { id: t.id, name: t.englishName || t.name, short: t.shortName || t.id, language: t.language };
    }
    return { id, name: id, short: id, language: 'eng' };
  }

  async function loadCompleteBible(transId) {
    const id = transId || getTranslationId();
    if (completeCache[id]) return completeCache[id];
    if (completePromises[id]) return completePromises[id];
    completePromises[id] = fetch(`${BIBLE_API_ORIGIN}/api/${id}/complete.json`)
      .then(async (res) => {
        if (!res.ok) throw new Error(`Bible unavailable (${res.status})`);
        const data = await res.json();
        if (!data || !Array.isArray(data.books)) throw new Error('Invalid Bible data');
        completeCache[id] = data;
        return data;
      })
      .catch((err) => {
        delete completePromises[id];
        throw err;
      });
    return completePromises[id];
  }

  async function fetchChapter(bookCode, chapterNum, transId) {
    const id = transId || getTranslationId();
    try {
      const complete = await loadCompleteBible(id);
      const book = complete.books.find((b) => b.id === bookCode);
      if (book && Array.isArray(book.chapters)) {
        const entry = book.chapters.find((c) => c.chapter && c.chapter.number === chapterNum);
        if (entry && entry.chapter) {
          return {
            bookName: book.commonName || book.name || bookCode,
            translation: complete.translation?.englishName || translationMeta(id).name,
            translationId: id,
            chapter: entry.chapter,
            chapterAudioLinks: entry.thisChapterAudioLinks || null
          };
        }
      }
    } catch (e) {
      console.warn('[BibleCore] complete.json miss, trying chapter file', e);
    }
    const res = await fetch(`${BIBLE_API_ORIGIN}/api/${id}/${bookCode}/${chapterNum}.json`);
    if (!res.ok) throw new Error(`Chapter unavailable (${res.status})`);
    const data = await res.json();
    if (!data || !data.chapter) throw new Error('Invalid chapter');
    return {
      bookName: data.book?.commonName || data.book?.name || bookCode,
      translation: data.translation?.englishName || translationMeta(id).name,
      translationId: id,
      chapter: data.chapter,
      chapterAudioLinks: data.thisChapterAudioLinks || null
    };
  }

  function getProgress() {
    try {
      return JSON.parse(localStorage.getItem('reader_progress') || 'null');
    } catch (e) {
      return null;
    }
  }

  function saveProgress(bookCode, chapter, verse, transId) {
    const progress = {
      bookCode,
      chapter,
      verse: verse || 1,
      transId: transId || getTranslationId(),
      updatedAt: Date.now()
    };
    localStorage.setItem('reader_progress', JSON.stringify(progress));
    return progress;
  }

  function getBookmarks() {
    try {
      const list = JSON.parse(localStorage.getItem('reader_bookmarks') || '[]');
      return Array.isArray(list) ? list : [];
    } catch (e) {
      return [];
    }
  }

  function addBookmark(ref, text, transId) {
    const bookmarks = getBookmarks();
    const id = `${ref}-${Date.now()}`;
    const entry = { id, ref, text: (text || '').slice(0, 500), transId: transId || getTranslationId(), createdAt: Date.now() };
    bookmarks.unshift(entry);
    localStorage.setItem('reader_bookmarks', JSON.stringify(bookmarks.slice(0, 200)));
    return entry;
  }

  function removeBookmark(id) {
    const bookmarks = getBookmarks().filter((b) => b.id !== id);
    localStorage.setItem('reader_bookmarks', JSON.stringify(bookmarks));
    return bookmarks;
  }

  function isBookmarked(ref) {
    return getBookmarks().some((b) => b.ref === ref);
  }

  function parseRoute() {
    const hash = (location.hash || '').replace(/^#\/?/, '');
    const parts = hash.split('/').filter(Boolean);
    if (parts.length >= 2) {
      const book = findBook(parts[0]);
      const chapter = parseInt(parts[1], 10);
      const verse = parts[2] ? parseInt(parts[2], 10) : null;
      if (book && chapter >= 1 && chapter <= book.chapters) {
        return { book, chapter, verse: verse && verse > 0 ? verse : null };
      }
    }
    const progress = getProgress();
    if (progress && progress.bookCode) {
      const book = findBook(progress.bookCode);
      if (book) {
        return { book, chapter: progress.chapter || 1, verse: progress.verse || null };
      }
    }
    return { book: findBook('JHN'), chapter: 1, verse: null };
  }

  function setRoute(bookCode, chapter, verse) {
    const v = verse ? `/${verse}` : '';
    const next = `#/${bookCode}/${chapter}${v}`;
    if (location.hash !== next) history.replaceState(null, '', next);
  }

  const DEFAULT_READER_TOOLS = {
    speaker: true,
    bookmark: true,
    highlight: true,
    wordStudy: true
  };

  function getReaderSettings() {
    try {
      const saved = JSON.parse(localStorage.getItem('reader_settings') || '{}');
      return {
        fontSize: 'md',
        lineHeight: 'relaxed',
        ...saved,
        tools: { ...DEFAULT_READER_TOOLS, ...(saved.tools || {}) }
      };
    } catch (e) {
      return { fontSize: 'md', lineHeight: 'relaxed', tools: { ...DEFAULT_READER_TOOLS } };
    }
  }

  function saveReaderSettings(patch) {
    const next = { ...getReaderSettings(), ...patch };
    localStorage.setItem('reader_settings', JSON.stringify(next));
    return next;
  }

  global.BibleCore = {
    BIBLE_API_ORIGIN,
    BIBLE_BOOKS,
    ENGLISH_TRANS,
    LANG_OPTIONS,
    LANG_DEFAULT_TRANS,
    allBooks,
    findBook,
    parseChapterContent,
    getReadingLang,
    setReadingLang,
    getTranslationId,
    setTranslationId,
    loadTranslationsCatalog,
    translationsForLang,
    translationMeta,
    loadCompleteBible,
    fetchChapter,
    getProgress,
    saveProgress,
    getBookmarks,
    addBookmark,
    removeBookmark,
    isBookmarked,
    parseRoute,
    setRoute,
    getReaderSettings,
    saveReaderSettings
  };
})(typeof window !== 'undefined' ? window : globalThis);