/**
 * Offline verse study — Greek/Hebrew originals, lexicon glosses, passage context.
 * Shared by /read and /app Library.
 */
(function (global) {
  'use strict';

  const BC = global.BibleCore;
  const API = BC?.BIBLE_API_ORIGIN || 'https://bible.helloao.org';

  const NT_BOOK_CODES = new Set(
    (BC?.BIBLE_BOOKS?.nt || []).map((b) => b.code)
  );

  let studyLexicon = null;
  let studyLexiconPromise = null;

  const GREEK_FORM_ALIASES = {
    'ηγαπησεν': 'αγαπαω', 'ηγαπησαν': 'αγαπαω', 'ηγαπηκασι': 'αγαπαω', 'ηγαπημεν': 'αγαπαω',
    'ηγαπησα': 'αγαπαω', 'αγαπησεν': 'αγαπαω', 'αγαπησαν': 'αγαπαω', 'αγαπησει': 'αγαπαω',
    'εδωκεν': 'διδωμι', 'εδωκαν': 'διδωμι', 'εδωκα': 'διδωμι', 'δωσει': 'διδωμι', 'δωσω': 'διδωμι',
    'εχη': 'εχω', 'εχει': 'εχω', 'εχουσιν': 'εχω', 'εχετε': 'εχω', 'εχομεν': 'εχω', 'εσχον': 'εχω',
    'υιον': 'υιος', 'υιου': 'υιος', 'υιοι': 'υιος', 'υιω': 'υιος',
    'κοσμον': 'κοσμος', 'κοσμου': 'κοσμος', 'κοσμω': 'κοσμος',
    'πιστευων': 'πιστευω', 'πιστευουσιν': 'πιστευω', 'πιστευετε': 'πιστευω', 'πιστευσαν': 'πιστευω',
    'πιστευση': 'πιστευω', 'επιστευσαν': 'πιστευω',
    'αποληται': 'απολλυμι', 'απολωνται': 'απολλυμι', 'απολεσθαι': 'απολλυμι',
    'ζωην': 'ζωη', 'ζωης': 'ζωη', 'ζωη': 'ζωη',
    'αιωνιον': 'αιωνιος', 'αιωνιος': 'αιωνιος', 'αιωνιου': 'αιωνιος',
    'μονογενη': 'μονογενης', 'μονογενους': 'μονογενης',
    'αυτον': 'αυτος', 'αυτου': 'αυτος', 'αυτοις': 'αυτος', 'αυτοι': 'αυτος', 'αυτην': 'αυτος',
    'λογον': 'λογος', 'λογου': 'λογος', 'λογω': 'λογος',
    'θεον': 'θεος', 'θεου': 'θεος', 'θεω': 'θεος',
    'ουρανον': 'ουρανος', 'ουρανου': 'ουρανος',
    'γην': 'γη', 'γης': 'γη',
    'φωτος': 'φως', 'φωτι': 'φως',
    'αρχην': 'αρχη', 'αρχης': 'αρχη',
    'σωθη': 'σωζω', 'σωθηναι': 'σωζω', 'εσωθη': 'σωζω', 'σωζει': 'σωζω',
    'ειπεν': 'λεγω', 'λεγει': 'λεγω', 'ειπαν': 'λεγω', 'λεγουσιν': 'λεγω',
    'εποιησεν': 'ποιεω', 'εποιησαν': 'ποιεω', 'ποιει': 'ποιεω',
    'ην': 'ειμι', 'εστιν': 'ειμι', 'εστε': 'ειμι', 'εσμεν': 'ειμι'
  };

  function isNtBook(bookCode) {
    return NT_BOOK_CODES.has(bookCode);
  }

  async function loadStudyLexicon() {
    if (studyLexicon) return studyLexicon;
    if (studyLexiconPromise) return studyLexiconPromise;
    studyLexiconPromise = fetch('/data/study-lexicon.json')
      .then((res) => {
        if (!res.ok) throw new Error('Lexicon unavailable');
        return res.json();
      })
      .then((data) => {
        studyLexicon = data;
        return data;
      })
      .catch((err) => {
        studyLexiconPromise = null;
        throw err;
      });
    return studyLexiconPromise;
  }

  function parseContent(content) {
    if (BC && BC.parseChapterContent) return BC.parseChapterContent(content);
    return [];
  }

  async function getVerseTextFromComplete(complete, bookCode, chapterNum, verseNum) {
    const book = complete.books.find((b) => b.id === bookCode);
    if (!book || !Array.isArray(book.chapters)) return null;
    const entry = book.chapters.find((c) => c.chapter && c.chapter.number === chapterNum);
    if (!entry?.chapter?.content) return null;
    const blocks = parseContent(entry.chapter.content);
    const verse = blocks.find((b) => b.type === 'verse' && b.number === verseNum);
    return verse ? verse.text : null;
  }

  async function fetchOriginalVerseFromApi(transId, bookCode, chapterNum, verseNum) {
    try {
      const complete = BC
        ? await BC.loadCompleteBible(transId)
        : await fetch(`${API}/api/${transId}/complete.json`).then((r) => r.json());
      const text = await getVerseTextFromComplete(complete, bookCode, chapterNum, verseNum);
      if (text) return text;
    } catch (e) { /* fall through */ }

    const res = await fetch(`${API}/api/${transId}/${bookCode}/${chapterNum}.json`);
    if (!res.ok) return null;
    const data = await res.json();
    const blocks = parseContent(data?.chapter?.content || []);
    const verse = blocks.find((b) => b.type === 'verse' && b.number === verseNum);
    return verse ? verse.text : null;
  }

  async function fetchOriginalVerseTexts(bookCode, chapterNum, verseNum) {
    const isNT = isNtBook(bookCode);
    if (isNT) {
      const greek = await fetchOriginalVerseFromApi('grc_sbl', bookCode, chapterNum, verseNum);
      return {
        originalText: greek,
        originalLabel: 'SBL Greek NT',
        lang: 'greek'
      };
    }
    const hebrew = await fetchOriginalVerseFromApi('hbo_wlc', bookCode, chapterNum, verseNum);
    return {
      originalText: hebrew,
      originalLabel: 'Westminster Leningrad Codex (Hebrew)',
      lang: 'hebrew'
    };
  }

  function normalizeGreekToken(token) {
    return token
      .replace(/[⸀⸁⸂⸃.,;:!?'"""''()[\]{}«»—–·]/g, '')
      .normalize('NFD')
      .replace(/\p{M}/gu, '')
      .toLowerCase();
  }

  function normalizeHebrewToken(token) {
    return token
      .replace(/[.,;:!?'"""''()[\]{}—–·׃]/g, '')
      .normalize('NFD')
      .replace(/[\u0591-\u05C7]/g, '')
      .replace(/[^\u05D0-\u05EA]/g, '')
      .trim();
  }

  function greekStemCandidates(norm) {
    const candidates = [norm];
    const endings = [
      'ησεν', 'ησαν', 'ηκασι', 'ημεν', 'ησα', 'ησαι', 'ηται', 'ησθε',
      'σεν', 'σαν', 'σαι', 'σει', 'ται', 'μαι', 'ονται', 'ομαι', 'εται',
      'ειν', 'ει', 'ην', 'η', 'ων', 'ος', 'ον', 'ους', 'ου', 'ας', 'ης',
      'αν', 'ατε', 'ομεν', 'ετε', 'ουσι', 'υσι', 'υς', 'ες', 'εις'
    ];
    for (const end of endings) {
      if (norm.endsWith(end) && norm.length - end.length >= 3) {
        candidates.push(norm.slice(0, -end.length));
      }
    }
    const augmented = [...candidates];
    for (const c of augmented) {
      if (c.startsWith('η') && c.length > 4) candidates.push(c.slice(1));
      if (c.startsWith('ε') && c.length > 4) candidates.push(c.slice(1));
    }
    return [...new Set(candidates)];
  }

  function hebrewStemCandidates(norm) {
    const candidates = [norm];
    const prefixes = ['ו', 'ה', 'ב', 'כ', 'ל', 'מ', 'ש'];
    for (const p of prefixes) {
      if (norm.startsWith(p) && norm.length > 2) candidates.push(norm.slice(1));
    }
    return [...new Set(candidates)];
  }

  function findLexiconEntry(raw, lang) {
    if (!studyLexicon || !raw) return null;
    const dict = lang === 'hebrew' ? studyLexicon.hebrew : studyLexicon.greek;
    if (!dict) return null;

    const norm = lang === 'hebrew' ? normalizeHebrewToken(raw) : normalizeGreekToken(raw);
    if (!norm || norm.length < 2) return null;

    const aliasLemma = lang === 'greek' ? GREEK_FORM_ALIASES[norm] : null;
    if (aliasLemma && dict[aliasLemma]) {
      return { token: raw, lemma: aliasLemma, ...dict[aliasLemma] };
    }
    if (dict[norm]) {
      return { token: raw, lemma: norm, ...dict[norm] };
    }

    const candidates = lang === 'greek' ? greekStemCandidates(norm) : hebrewStemCandidates(norm);
    let best = null;
    let bestScore = 0;

    for (const cand of candidates) {
      const alias = lang === 'greek' ? GREEK_FORM_ALIASES[cand] : null;
      const lemmaKey = alias || cand;
      if (dict[lemmaKey]) {
        const score = lemmaKey.length + 120;
        if (score > bestScore) {
          best = { token: raw, lemma: lemmaKey, ...dict[lemmaKey] };
          bestScore = score;
        }
      }
      for (const key of Object.keys(dict)) {
        if (key.length < 3) continue;
        const stemLen = Math.min(5, key.length);
        const stem = key.slice(0, stemLen);
        if (stem.length < 4) continue;
        const containsStem = cand.includes(stem);
        const keyStartsCand = key.startsWith(cand) && cand.length >= 4;
        const candStartsKey = cand.startsWith(key) && key.length >= 3;
        if (!containsStem && !keyStartsCand && !candStartsKey) continue;
        const score = stem.length + (cand === key ? 40 : 0) + (containsStem ? 10 : 0);
        if (cand.length < 3 && key !== cand) continue;
        if (score > bestScore) {
          best = { token: raw, lemma: key, ...dict[key] };
          bestScore = score;
        }
      }
    }
    return best;
  }

  function lookupLexiconWords(text, lang, max = 8) {
    if (!studyLexicon || !text) return [];
    const rawTokens = text.split(/\s+/).filter(Boolean);
    const seen = new Set();
    const matches = [];

    for (const raw of rawTokens) {
      const entry = findLexiconEntry(raw, lang);
      if (!entry) continue;
      const dedupeKey = entry.lemma || entry.translit;
      if (seen.has(dedupeKey)) continue;
      seen.add(dedupeKey);
      matches.push({
        token: entry.token,
        translit: entry.translit,
        gloss: entry.gloss,
        note: entry.note || ''
      });
      if (matches.length >= max) break;
    }
    return matches;
  }

  function findSectionHeading(verses, verseNum) {
    let heading = '';
    for (const v of verses) {
      if (v.type === 'heading') heading = v.text;
      if (v.type === 'verse' && v.number === verseNum) break;
    }
    return heading;
  }

  function getNeighborVerses(verses, verseNum, bookName, chapterNum) {
    const onlyVerses = verses.filter((v) => v.type === 'verse');
    const idx = onlyVerses.findIndex((v) => v.number === verseNum);
    const prev = idx > 0
      ? { ref: `${bookName} ${chapterNum}:${onlyVerses[idx - 1].number}`, text: onlyVerses[idx - 1].text }
      : null;
    const next = idx >= 0 && idx < onlyVerses.length - 1
      ? { ref: `${bookName} ${chapterNum}:${onlyVerses[idx + 1].number}`, text: onlyVerses[idx + 1].text }
      : null;
    return { prev, next };
  }

  function buildContextNarrative(opts) {
    const langName = opts.isNT ? 'Greek' : 'Hebrew';
    const parts = [];
    parts.push(`"${opts.english}"`);
    if (opts.prev) parts.push(`follows ${opts.prev.ref} ("${opts.prev.text}")`);
    if (opts.next) parts.push(`and leads into ${opts.next.ref} ("${opts.next.text}")`);
    let narrative = `${opts.ref} in context: ${parts.join(', ')}.`;
    if (opts.lexWords.length) {
      const terms = opts.lexWords.slice(0, 6).map((w) => `${w.translit} ("${w.gloss}")`).join(', ');
      narrative += ` In ${langName}, the major words are ${terms}.`;
      const lead = opts.lexWords.slice(0, 3).map((w) => {
        const detail = w.note ? ` ${w.note}` : '';
        return `${w.translit} means "${w.gloss}"${detail ? ' —' + detail : ''}`;
      }).join('; ');
      narrative += ` So in English: ${lead}.`;
      narrative += ` Together these ${langName} terms show what this verse is saying within its immediate passage.`;
    } else if (opts.originalText) {
      narrative += ` The original ${langName} text is shown above; surrounding verses help place this line in the flow of the chapter.`;
    }
    return narrative;
  }

  async function loadVerseStudy(params) {
    const {
      bookCode,
      chapterNum,
      verseNum,
      english,
      bookName,
      translationShort,
      chapterBlocks
    } = params;

    await loadStudyLexicon();
    const isNT = isNtBook(bookCode);
    const lang = isNT ? 'greek' : 'hebrew';
    const langLabel = isNT ? 'Greek' : 'Hebrew';
    const ref = `${bookName} ${chapterNum}:${verseNum}`;

    const originals = await fetchOriginalVerseTexts(bookCode, chapterNum, verseNum);
    const heading = findSectionHeading(chapterBlocks || [], verseNum);
    const { prev, next } = getNeighborVerses(chapterBlocks || [], verseNum, bookName, chapterNum);
    const lexWords = lookupLexiconWords(originals.originalText, lang);

    const contextNarrative = buildContextNarrative({
      ref,
      english,
      prev,
      next,
      lexWords,
      isNT,
      originalText: originals.originalText
    });

    return {
      ref,
      langLabel,
      isNT,
      heading,
      english,
      translationShort: translationShort || 'BSB',
      originalText: originals.originalText,
      originalLabel: originals.originalLabel,
      lexWords,
      prev,
      next,
      contextNarrative
    };
  }

  global.StudyCore = {
    isNtBook,
    loadStudyLexicon,
    loadVerseStudy,
    lookupLexiconWords,
    fetchOriginalVerseTexts
  };
})(typeof window !== 'undefined' ? window : globalThis);