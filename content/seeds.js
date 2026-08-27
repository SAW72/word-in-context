/**
 * Seed bank: questions people actually ask, each tied to a fetched ref.
 * Original letters are never stored here — they come from live helloao fetches.
 */
const STUDY_SEEDS = [
  {
    id: 'porneia_matt_19_9',
    pillarId: 'word_study',
    question: 'Does Matthew 19:9 allow divorce for any reason?',
    passages: [
      {
        ref: 'Matthew 19:9',
        focusRe: /πορνεί[αάᾳ]ς?/,
        translit: 'porneia',
      },
    ],
  },
  {
    id: 'hesed_psalm_136',
    pillarId: 'word_study',
    question: 'What does Psalm 136 keep repeating with hesed?',
    passages: [
      {
        ref: 'Psalm 136:1',
        focusNeedle: 'חסד',
        translit: 'hesed',
      },
    ],
  },
  {
    id: 'sheol_vs_gehenna',
    pillarId: 'hard_question',
    question: 'Are Sheol and Gehenna the same word?',
    passages: [
      {
        ref: 'Psalm 16:10',
        focusNeedle: 'שאול',
        translit: 'Sheol',
      },
      {
        ref: 'Matthew 10:28',
        focusRe: /γεένν[ῃηανης]+/,
        translit: 'Gehenna',
      },
    ],
  },
  {
    id: 'logos_john_1_14',
    pillarId: 'gospel_passage',
    question: 'What does John 1:14 say the Word became?',
    passages: [
      {
        ref: 'John 1:14',
        focusRe: /λόγος/,
        translit: 'logos',
      },
    ],
  },
  {
    id: 'metanoia_2cor_7_10',
    pillarId: 'word_study',
    question: 'Does metanoia just mean feeling sorry?',
    passages: [
      {
        ref: '2 Corinthians 7:10',
        focusRe: /μετάνοιαν|μετάνοια/,
        translit: 'metanoia',
      },
    ],
  },
  {
    id: 'petra_matt_16_18',
    pillarId: 'literary_context',
    question: 'What is the rock in Matthew 16:18?',
    passages: [
      {
        ref: 'Matthew 16:18',
        focusRe: /πέτρᾳ|Πέτρος|πέτρα/,
        translit: 'petra',
      },
    ],
  },
];

function getSeedById(id) {
  return STUDY_SEEDS.find((s) => s.id === id) || null;
}

function getSeedByRef(reference) {
  const needle = String(reference || '').trim().toLowerCase();
  if (!needle) return null;
  return (
    STUDY_SEEDS.find((s) =>
      s.passages.some((p) => p.ref.toLowerCase() === needle)
    ) || null
  );
}

module.exports = {
  STUDY_SEEDS,
  getSeedById,
  getSeedByRef,
};
