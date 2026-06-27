/** Canonical book list — matches public/bible-core.js */
export const BIBLE_BOOKS = {
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

export function allBooks() {
  return [...BIBLE_BOOKS.ot, ...BIBLE_BOOKS.nt];
}

export function findBook(code) {
  return allBooks().find((b) => b.code === code) || null;
}