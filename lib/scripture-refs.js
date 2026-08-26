/**
 * Bible reference extraction and book-code resolution for live helloao fetches.
 * Used by the /api/chat grounding path. Keep in sync with product: chapter-only
 * refs (Psalm 136, John 1) and common aliases (1 Cor, Song of Songs) must resolve.
 */

const SKIP_BOOKS = new Set([
  'chapter', 'chapters', 'verse', 'verses', 'vs', 'cf', 'see', 'and', 'or', 'the',
  'a', 'an', 'of', 'in', 'to', 'for', 'from', 'with', 'about', 'what', 'when',
  'how', 'why', 'book', 'passage', 'section', 'line', 'page', 'scene', 'item',
  'point', 'step', 'part', 'day', 'year', 'age', 'v', 'vv', 'ref', 'refs',
]);

const BOOK_MAP = {
  genesis: 'GEN', gen: 'GEN',
  exodus: 'EXO', exo: 'EXO', ex: 'EXO',
  leviticus: 'LEV', lev: 'LEV',
  numbers: 'NUM', num: 'NUM',
  deuteronomy: 'DEU', deut: 'DEU', dt: 'DEU',
  joshua: 'JOS', josh: 'JOS',
  judges: 'JDG', judg: 'JDG',
  ruth: 'RUT',
  '1 samuel': '1SA', '1samuel': '1SA', '1sam': '1SA', '1 sam': '1SA',
  '2 samuel': '2SA', '2samuel': '2SA', '2sam': '2SA', '2 sam': '2SA',
  '1 kings': '1KI', '1kings': '1KI', '1ki': '1KI', '1 ki': '1KI',
  '2 kings': '2KI', '2kings': '2KI', '2ki': '2KI', '2 ki': '2KI',
  '1 chronicles': '1CH', '1chronicles': '1CH', '1chr': '1CH', '1 chr': '1CH',
  '2 chronicles': '2CH', '2chronicles': '2CH', '2chr': '2CH', '2 chr': '2CH',
  ezra: 'EZR',
  nehemiah: 'NEH', neh: 'NEH',
  esther: 'EST',
  job: 'JOB',
  psalm: 'PSA', psalms: 'PSA', ps: 'PSA', psa: 'PSA',
  proverbs: 'PRO', prov: 'PRO', pr: 'PRO',
  ecclesiastes: 'ECC', eccl: 'ECC', ecc: 'ECC',
  'song of solomon': 'SNG', 'song of songs': 'SNG', 'song of sol': 'SNG',
  song: 'SNG', canticles: 'SNG', sos: 'SNG', solomon: 'SNG',
  isaiah: 'ISA', isa: 'ISA',
  jeremiah: 'JER', jer: 'JER',
  lamentations: 'LAM', lam: 'LAM',
  ezekiel: 'EZE', ezek: 'EZE',
  daniel: 'DAN', dan: 'DAN',
  hosea: 'HOS', hos: 'HOS',
  joel: 'JOL',
  amos: 'AMO',
  obadiah: 'OBA', obad: 'OBA',
  jonah: 'JON',
  micah: 'MIC', mic: 'MIC',
  nahum: 'NAM',
  habakkuk: 'HAB', hab: 'HAB',
  zephaniah: 'ZEP', zeph: 'ZEP',
  haggai: 'HAG', hag: 'HAG',
  zechariah: 'ZEC', zech: 'ZEC',
  malachi: 'MAL', mal: 'MAL',
  matthew: 'MAT', matt: 'MAT', mt: 'MAT', mathew: 'MAT',
  mark: 'MRK', mk: 'MRK',
  luke: 'LUK', lk: 'LUK',
  john: 'JHN', jn: 'JHN',
  acts: 'ACT',
  romans: 'ROM', rom: 'ROM',
  '1 corinthians': '1CO', '1corinthians': '1CO', '1cor': '1CO', '1 cor': '1CO',
  '1co': '1CO',
  '2 corinthians': '2CO', '2corinthians': '2CO', '2cor': '2CO', '2 cor': '2CO',
  galatians: 'GAL', gal: 'GAL',
  ephesians: 'EPH', eph: 'EPH',
  philippians: 'PHP', phil: 'PHP',
  colossians: 'COL', col: 'COL',
  '1 thessalonians': '1TH', '1thessalonians': '1TH', '1thess': '1TH', '1 thess': '1TH',
  '2 thessalonians': '2TH', '2thessalonians': '2TH', '2thess': '2TH', '2 thess': '2TH',
  '1 timothy': '1TI', '1timothy': '1TI', '1tim': '1TI', '1 tim': '1TI',
  '2 timothy': '2TI', '2timothy': '2TI', '2tim': '2TI', '2 tim': '2TI',
  titus: 'TIT',
  philemon: 'PHM', phlm: 'PHM', phm: 'PHM',
  hebrews: 'HEB', heb: 'HEB',
  james: 'JAS', jas: 'JAS',
  '1 peter': '1PE', '1peter': '1PE', '1pet': '1PE', '1 pet': '1PE',
  '2 peter': '2PE', '2peter': '2PE', '2pet': '2PE', '2 pet': '2PE',
  '1 john': '1JN', '1john': '1JN', '1jn': '1JN', '1 jn': '1JN',
  '2 john': '2JN', '2john': '2JN', '2jn': '2JN', '2 jn': '2JN',
  '3 john': '3JN', '3john': '3JN', '3jn': '3JN', '3 jn': '3JN',
  jude: 'JUD',
  revelation: 'REV', rev: 'REV',
};

const BOOK_DISPLAY = {
  GEN: 'Genesis', EXO: 'Exodus', LEV: 'Leviticus', NUM: 'Numbers', DEU: 'Deuteronomy',
  JOS: 'Joshua', JDG: 'Judges', RUT: 'Ruth', '1SA': '1 Samuel', '2SA': '2 Samuel',
  '1KI': '1 Kings', '2KI': '2 Kings', '1CH': '1 Chronicles', '2CH': '2 Chronicles',
  EZR: 'Ezra', NEH: 'Nehemiah', EST: 'Esther', JOB: 'Job', PSA: 'Psalm',
  PRO: 'Proverbs', ECC: 'Ecclesiastes', SNG: 'Song of Solomon', ISA: 'Isaiah',
  JER: 'Jeremiah', LAM: 'Lamentations', EZE: 'Ezekiel', DAN: 'Daniel',
  HOS: 'Hosea', JOL: 'Joel', AMO: 'Amos', OBA: 'Obadiah', JON: 'Jonah',
  MIC: 'Micah', NAM: 'Nahum', HAB: 'Habakkuk', ZEP: 'Zephaniah', HAG: 'Haggai',
  ZEC: 'Zechariah', MAL: 'Malachi', MAT: 'Matthew', MRK: 'Mark', LUK: 'Luke',
  JHN: 'John', ACT: 'Acts', ROM: 'Romans', '1CO': '1 Corinthians', '2CO': '2 Corinthians',
  GAL: 'Galatians', EPH: 'Ephesians', PHP: 'Philippians', COL: 'Colossians',
  '1TH': '1 Thessalonians', '2TH': '2 Thessalonians', '1TI': '1 Timothy', '2TI': '2 Timothy',
  TIT: 'Titus', PHM: 'Philemon', HEB: 'Hebrews', JAS: 'James',
  '1PE': '1 Peter', '2PE': '2 Peter', '1JN': '1 John', '2JN': '2 John', '3JN': '3 John',
  JUD: 'Jude', REV: 'Revelation',
};

function escapeRegExp(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const BOOK_NAMES_LONG_FIRST = Object.keys(BOOK_MAP)
  .filter((name) => !SKIP_BOOKS.has(name))
  .sort((a, b) => b.length - a.length);

const BOOK_ALT = BOOK_NAMES_LONG_FIRST.map(escapeRegExp).join('|');

// Spoken chapter/verse numbers (voice: "Matthew nineteen nine", "Matthew 19 9").
// A single number is digits, 1–19, tens+ones, or "[ones] hundred [below-100]" —
// never two independent small numbers ("nineteen nine" is 19 then 9, not 28).
const ONES_WORDS = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9,
};
const TEENS_WORDS = {
  ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14,
  fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19,
};
const TENS_WORDS = {
  twenty: 20, thirty: 30, forty: 40, fifty: 50,
  sixty: 60, seventy: 70, eighty: 80, ninety: 90,
};
const ONES_ALT = Object.keys(ONES_WORDS).sort((a, b) => b.length - a.length).join('|');
const TEENS_ALT = Object.keys(TEENS_WORDS).sort((a, b) => b.length - a.length).join('|');
const TENS_ALT = Object.keys(TENS_WORDS).sort((a, b) => b.length - a.length).join('|');
const BELOW100 = `(?:${TEENS_ALT}|${TENS_ALT}(?:[\\s-]+(?:${ONES_ALT}))?|${ONES_ALT})`;
const HUNDRED = `(?:(?:${ONES_ALT})[\\s-]+)?hundred(?:[\\s-]+(?:and[\\s-]+)?${BELOW100})?`;
const NUM = `(?:\\d+|${HUNDRED}|${BELOW100})`;
const REF_RE = new RegExp(
  `\\b(${BOOK_ALT})\\s+(${NUM})(?:[:\\s]+(${NUM})(?:-(${NUM}))?)?\\b`,
  'gi'
);
const PARSE_RE = new RegExp(
  `^(${BOOK_ALT})\\s+(${NUM})(?:[:\\s]+(${NUM})(?:-(${NUM}))?)?$`,
  'i'
);

function parseBelow100(tokens, i) {
  const t = tokens[i];
  if (TEENS_WORDS[t] != null) return { value: TEENS_WORDS[t], next: i + 1 };
  if (TENS_WORDS[t] != null) {
    if (ONES_WORDS[tokens[i + 1]] != null) {
      return { value: TENS_WORDS[t] + ONES_WORDS[tokens[i + 1]], next: i + 2 };
    }
    return { value: TENS_WORDS[t], next: i + 1 };
  }
  if (ONES_WORDS[t] != null) return { value: ONES_WORDS[t], next: i + 1 };
  return null;
}

function parseSpokenNumber(raw) {
  if (raw == null) return NaN;
  const s = String(raw).trim().toLowerCase().replace(/,/g, '');
  if (!s) return NaN;
  if (/^\d+$/.test(s)) return parseInt(s, 10);
  const tokens = s.split(/[\s-]+/).filter((t) => t && t !== 'and');
  if (!tokens.length) return NaN;
  let i = 0;
  let value = 0;
  if (tokens[i + 1] === 'hundred' && ONES_WORDS[tokens[i]] != null) {
    value = ONES_WORDS[tokens[i]] * 100;
    i += 2;
  } else if (tokens[i] === 'hundred') {
    value = 100;
    i += 1;
  }
  if (i < tokens.length) {
    const rest = parseBelow100(tokens, i);
    if (!rest || rest.next !== tokens.length) return NaN;
    value += rest.value;
  } else if (value === 0) {
    return NaN;
  }
  return value > 0 ? value : NaN;
}

function normalizeBookKey(book) {
  return String(book || '').toLowerCase().replace(/\s+/g, ' ').trim();
}

function resolveBookCode(book) {
  const key = normalizeBookKey(book);
  if (!key || SKIP_BOOKS.has(key)) return null;
  return BOOK_MAP[key] || null;
}

function formatExtractedRef(parsed) {
  if (parsed.wholeChapter) return `${parsed.bookDisplay} ${parsed.chapter}`;
  return `${parsed.bookDisplay} ${parsed.chapter}:${parsed.verseStart}${
    parsed.verseEnd !== parsed.verseStart ? '-' + parsed.verseEnd : ''
  }`;
}

function parseReference(reference) {
  if (!reference || typeof reference !== 'string') return null;
  const cleaned = reference.trim().replace(/\s+/g, ' ');
  const match = cleaned.match(PARSE_RE);
  if (!match) return null;
  const bookRaw = match[1].trim();
  const bookCode = resolveBookCode(bookRaw);
  if (!bookCode) return null;
  const chapter = parseSpokenNumber(match[2]);
  if (!Number.isFinite(chapter) || chapter < 1) return null;
  const wholeChapter = match[3] == null;
  const verseStart = wholeChapter ? 1 : parseSpokenNumber(match[3]);
  if (!wholeChapter && (!Number.isFinite(verseStart) || verseStart < 1)) return null;
  const verseEnd = wholeChapter
    ? Number.POSITIVE_INFINITY
    : parseSpokenNumber(match[4] || match[3]);
  if (!wholeChapter && (!Number.isFinite(verseEnd) || verseEnd < verseStart)) return null;
  return {
    bookRaw,
    bookCode,
    bookDisplay: BOOK_DISPLAY[bookCode] || bookRaw,
    chapter,
    verseStart,
    verseEnd,
    wholeChapter,
  };
}

function extractRefs(text) {
  if (!text || typeof text !== 'string') return [];
  const found = [];
  const seen = new Set();
  REF_RE.lastIndex = 0;
  let m;
  while ((m = REF_RE.exec(text))) {
    const raw = m[0].replace(/\s+/g, ' ').trim();
    const parsed = parseReference(raw);
    if (!parsed) continue;
    const key = parsed.wholeChapter
      ? `${parsed.bookCode} ${parsed.chapter}`
      : `${parsed.bookCode} ${parsed.chapter}:${parsed.verseStart}-${Number.isFinite(parsed.verseEnd) ? parsed.verseEnd : parsed.verseStart}`;
    if (seen.has(key)) continue;
    seen.add(key);
    found.push(formatExtractedRef(parsed));
  }
  return found;
}

function userAskedExtraGreekEditions(text) {
  if (!text || typeof text !== 'string') return false;
  return /\b(byzantine|majority\s+text|textus\s+receptus|(?:the\s+)?t\.?\s*r\.?)\b/i.test(text);
}

function extraGreekEditionIds(text) {
  if (!userAskedExtraGreekEditions(text)) return [];
  const t = text.toLowerCase();
  const ids = [];
  if (/\b(byzantine|majority\s+text)\b/.test(t)) ids.push('grc_byz');
  if (/\b(textus\s+receptus|(?:the\s+)?t\.?\s*r\.?)\b/.test(t)) ids.push('grc_gtr');
  if (!ids.length) ids.push('grc_byz', 'grc_gtr');
  return [...new Set(ids)];
}

function isWordStudyFollowUp(text) {
  if (!text || typeof text !== 'string') return false;
  if (extractRefs(text).length > 0) return false;
  const t = text.toLowerCase().trim();
  return /\b(greek|hebrew|aramaic|original language|transliterat|word study|lexical|underlying word|root word)\b/.test(t)
    || /\b(what does|meaning of|meanings of|define|definition of)\b/.test(t)
      && /\b(greek|hebrew|aramaic|word|term)\b/.test(t);
}

const DIVORCE_PRIMARY_WITNESSES = ['Matthew 19:9', '1 Corinthians 7:15'];

const MARRIAGE_SEX_REFS = [
  '1 Corinthians 6:18', '1 Corinthians 7:2', 'Hebrews 13:4',
  'Matthew 5:27', 'Matthew 5:32', 'Exodus 20:14', '1 Thessalonians 4:3',
];

const DIVORCE_STUDY_ORDER_REFS = [
  'Matthew 19:9', '1 Corinthians 7:15', 'Matthew 5:32',
  'Mark 10:11', 'Luke 16:18', '1 Corinthians 7:10', 'Romans 7:2',
];

function uniqueRefs(refs) {
  const out = [];
  const seen = new Set();
  for (const r of refs || []) {
    if (!r || seen.has(r)) continue;
    seen.add(r);
    out.push(r);
  }
  return out;
}

function isDivorceRemarriageTopic(text) {
  if (!text || typeof text !== 'string') return false;
  const t = text.toLowerCase();
  const divorceOrRemarry = /\b(divorce|divorced|remarr(?:y|iage|ied)|free to (?:re)?marry|not under bondage)\b/.test(t)
    || /\b(free to remarr|may (?:the |they |he |she )?remarr|allowed to remarr|forbid.*remarr)\b/.test(t);
  const marriageFrame = /\b(spouse|wife|husband|marri|adulter|sexual immorality|porneia)\b/.test(t);
  return (divorceOrRemarry && marriageFrame)
    || /\b(free to remarr|may (?:the |they |he |she )?remarr|allowed to remarr|forbid.*remarr)\b/.test(t)
    || /\b(divorce|divorced)\b/.test(t)
    || /\bremarr/.test(t);
}

function shouldPinDivorcePrimaryWitnesses(text, namedRefs = []) {
  if ((namedRefs || []).some((r) => r === 'Matthew 19:9' || r === '1 Corinthians 7:15')) {
    return true;
  }
  if (isDivorceRemarriageTopic(text)) return true;
  const t = String(text || '').toLowerCase();
  return /\b(adulter(?:y|ers?|ess(?:es)?|ous)?)\b/.test(t) || /\bporneia\b/.test(t);
}

function extractThematicRefs(text) {
  if (!text || typeof text !== 'string') return [];
  const t = text.toLowerCase();
  const refs = [];
  const paulLastTopic = /\b(paul|apostle paul)\b/.test(t)
    && /\b(last apostle|last of all|least of the apostles|untimely birth|abnormally born|what paul said|what did paul)\b/.test(t);
  const lastApostleTopic = /\blast apostle\b/.test(t);
  if (paulLastTopic || lastApostleTopic) {
    refs.push('1 Corinthians 15:8', '1 Corinthians 15:9', '1 Corinthians 15:7', '1 Corinthians 15:5');
  }
  if (/\bwhat (did |about )?paul\b/.test(t) && /\b(apostle|last)\b/.test(t)) {
    refs.push('1 Corinthians 15:8', '1 Corinthians 15:9');
  }
  if (/1\s?cor(?:inthians)?\s+15:8/i.test(t)) {
    refs.push('1 Corinthians 15:5-10');
  }
  const marriageSexTopic = /\b(sex outside (of )?marriage|sexual immorality|fornication|adultery|premarital sex|extramarital|porneia|unchastity|marriage bed|immorality)\b/.test(t)
    || (/\bsex\b/.test(t) && /\b(marriage|married|wife|husband|adultery|fornicat|immoral)\b/.test(t));
  // Divorce/remarriage primaries first when both topics match — otherwise
  // marriage-sex refs fill the fetch cap and John never sees Matt 19:9 / 1 Cor 7:15.
  if (isDivorceRemarriageTopic(text)) {
    refs.push(...DIVORCE_STUDY_ORDER_REFS);
  }
  if (marriageSexTopic) {
    refs.push(...MARRIAGE_SEX_REFS);
  }
  return uniqueRefs(refs);
}

function expandNearbyContextRefs(refs, text) {
  const t = String(text || '').toLowerCase();
  const cor15Eight = (refs || []).some((r) => /1\s?cor(?:inthians)?\s+15:(8|9|8-9|5-10)/i.test(r))
    || /1\s?cor(?:inthians)?\s+15:8/i.test(t);
  if (cor15Eight) {
    return ['1 Corinthians 15:5-10'];
  }
  return [...(refs || [])];
}

function isNarrowVerseQuestion(text, namedRefs) {
  if (!namedRefs?.length || !text) return false;
  const t = text.toLowerCase().trim();
  return /\bwhat about\b/.test(t)
    || namedRefs.length <= 2
    || (namedRefs.length <= 3 && t.length < 200);
}

/**
 * Study-order grounding: named refs first, then pinned primary witnesses,
 * then other thematic refs. Fetch cap cannot drop named refs or
 * Matthew 19:9 / 1 Corinthians 7:15 on the divorce/adultery/remarriage path.
 */
function selectStudyOrderRefs(text, opts = {}) {
  const namedRefs = extractRefs(text);
  const thematicRefs = extractThematicRefs(text);
  const priorRefs = opts.priorRefs || [];
  const narrowVerseFocus = isNarrowVerseQuestion(text, namedRefs);

  let combined = uniqueRefs([...namedRefs, ...thematicRefs, ...priorRefs]);
  if (narrowVerseFocus) {
    combined = expandNearbyContextRefs(combined, text);
  }

  const pinDivorce = shouldPinDivorcePrimaryWitnesses(text, namedRefs);
  const pinned = pinDivorce ? DIVORCE_PRIMARY_WITNESSES.slice() : [];
  const mustKeep = uniqueRefs([...namedRefs, ...pinned]);
  const rest = uniqueRefs(combined).filter((r) => !mustKeep.includes(r));

  const allCap = narrowVerseFocus ? 3 : 6;
  const fetchCap = narrowVerseFocus ? 2 : 4;
  const allRefs = uniqueRefs([
    ...mustKeep,
    ...rest.slice(0, Math.max(0, allCap - mustKeep.length)),
  ]);
  const fetchRefs = uniqueRefs([
    ...mustKeep,
    ...rest.slice(0, Math.max(0, fetchCap - mustKeep.length)),
  ]);

  return {
    namedRefs,
    thematicRefs,
    allRefs,
    fetchRefs,
    narrowVerseFocus,
    pinDivorce,
  };
}

function getBlockedContentReason(text) {
  if (!text || typeof text !== 'string') return null;
  const t = text.toLowerCase().replace(/\s+/g, ' ').trim();
  const adult = /\b(porn|pornograph|xxx|nudes?|fetish|onlyfans|hentai|nsfw|sext(?:ing)?|stripper|escort\s+service|adult\s+content|sex\s+toy)\b/.test(t);
  if (adult) {
    return 'This app is for Scripture study only. Adult or sexual content requests are not permitted.';
  }
  const harm = /\b(how\s+to\s+(kill|murder|harm|hurt|poison|stab|shoot)|make\s+a\s+bomb|build\s+a\s+bomb|suicide\s+method|self[- ]harm\s+method)\b/.test(t);
  if (harm) {
    return 'This app cannot assist with harming people. For crisis support, contact a pastor, counselor, or local emergency services.';
  }
  return null;
}

module.exports = {
  BOOK_MAP,
  DIVORCE_PRIMARY_WITNESSES,
  extractRefs,
  parseReference,
  parseSpokenNumber,
  resolveBookCode,
  userAskedExtraGreekEditions,
  extraGreekEditionIds,
  isWordStudyFollowUp,
  getBlockedContentReason,
  extractThematicRefs,
  isDivorceRemarriageTopic,
  shouldPinDivorcePrimaryWitnesses,
  selectStudyOrderRefs,
  expandNearbyContextRefs,
  isNarrowVerseQuestion,
};
