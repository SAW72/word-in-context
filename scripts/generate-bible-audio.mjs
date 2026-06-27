#!/usr/bin/env node
/**
 * Batch-generate Bible audio (verse MP3s) for configured voices + translations.
 *
 * Examples:
 *   node scripts/generate-bible-audio.mjs --dry-run
 *   node scripts/generate-bible-audio.mjs --voice grok-leo --translation BSB
 *   node scripts/generate-bible-audio.mjs --voice spencer-clone --book GEN --chapter 1
 *   node scripts/generate-bible-audio.mjs --resume
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { allBooks, findBook } from './lib/bible-books.mjs';
import { verseTextFromContent } from './lib/bible-text.mjs';
import { synthesize } from './lib/tts-providers.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const AUDIO_ROOT = process.env.AUDIO_STORAGE_PATH
  ? path.dirname(process.env.AUDIO_STORAGE_PATH)
  : path.join(ROOT, 'audio');
const GENERATED_ROOT = process.env.AUDIO_STORAGE_PATH || path.join(AUDIO_ROOT, 'generated');
const VOICES_PATH = path.join(AUDIO_ROOT, 'voices.json');
const REGISTRY_PATH = path.join(AUDIO_ROOT, 'registry.json');
const HELLOAO_BASE = 'https://bible.helloao.org/api';

function loadJson(filePath, fallback = null) {
  if (!fs.existsSync(filePath)) return fallback;
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function saveJson(filePath, data) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2) + '\n');
}

function parseArgs(argv) {
  const args = {
    voice: null,
    translation: null,
    book: null,
    chapter: null,
    resume: false,
    dryRun: false,
    force: false,
    delayMs: 250,
    limit: null,
  };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--resume') args.resume = true;
    else if (a === '--dry-run') args.dryRun = true;
    else if (a === '--force') args.force = true;
    else if (a === '--voice') args.voice = argv[++i];
    else if (a === '--translation') args.translation = argv[++i];
    else if (a === '--book') args.book = argv[++i]?.toUpperCase();
    else if (a === '--chapter') args.chapter = Number(argv[++i]);
    else if (a === '--delay') args.delayMs = Number(argv[++i]) || 250;
    else if (a === '--limit') args.limit = Number(argv[++i]);
    else if (a === '--help' || a === '-h') {
      console.log(`
Usage: node scripts/generate-bible-audio.mjs [options]

  --voice <slug>         e.g. grok-leo, spencer-clone (default: all enabled)
  --translation <id>     e.g. BSB (default: all enabled in voices.json)
  --book <id>            e.g. GEN, JHN
  --chapter <n>          single chapter only
  --resume               skip verses already in registry / on disk
  --force                regenerate even if file exists
  --dry-run              print plan only
  --delay <ms>           pause between API calls (default: 250)
  --limit <n>            stop after n verses (testing)
`);
      process.exit(0);
    }
  }
  return args;
}

function verseRelPath(translationId, voiceSlug, bookId, chapter, verse) {
  const ch = String(chapter).padStart(3, '0');
  const v = String(verse).padStart(3, '0');
  return path.join(translationId, voiceSlug, bookId, ch, `${v}.mp3`);
}

function versePublicUrl(relPath) {
  return `/audio/generated/${relPath.split(path.sep).join('/')}`;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function fetchTranslationData(translationId) {
  const url = `${HELLOAO_BASE}/${translationId}/complete.json`;
  console.log(`Fetching ${url} ...`);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to fetch ${translationId}: ${res.status}`);
  return res.json();
}

function buildWorkQueue(bibleData, args) {
  const queue = [];
  for (const bookMeta of allBooks()) {
    if (args.book && bookMeta.code !== args.book) continue;
    const bookData = bibleData.books?.find((b) => b.id === bookMeta.code);
    if (!bookData?.chapters) continue;

    for (const chEntry of bookData.chapters) {
      const chapterNum = chEntry.chapter?.number;
      if (!chapterNum) continue;
      if (args.chapter && chapterNum !== args.chapter) continue;

      const content = chEntry.chapter?.content || [];
      for (const item of content) {
        if (item.type !== 'verse' || typeof item.number !== 'number') continue;
        const text = verseTextFromContent(item.content);
        if (!text) continue;
        queue.push({
          bookId: bookMeta.code,
          bookName: bookMeta.name,
          chapter: chapterNum,
          verse: item.number,
          text,
        });
      }
    }
  }
  return queue;
}

function translationsList(voicesConfig) {
  const raw = voicesConfig.translations || {};
  return Object.entries(raw).map(([id, meta]) => ({ id, ...meta }));
}

function resolveJobs(voicesConfig, args) {
  const voices = voicesConfig.voices.filter((v) => {
    if (!v.enabled) return false;
    if (args.voice && v.slug !== args.voice) return false;
    return true;
  });

  const translations = translationsList(voicesConfig).filter((t) => {
    if (!t.enabled) return false;
    if (args.translation && t.id !== args.translation) return false;
    return true;
  });

  if (!voices.length) throw new Error('No matching enabled voices. Check audio/voices.json');
  if (!translations.length) throw new Error('No matching enabled translations.');

  return { voices, translations };
}

function registryHasVerse(registry, translationId, voiceSlug, bookId, chapter, verse) {
  const t = registry.translations?.[translationId];
  const v = t?.voices?.[voiceSlug];
  const b = v?.books?.[bookId];
  const ch = b?.chapters?.[String(chapter)];
  return ch?.verses?.[String(verse)]?.status === 'done';
}

function countRegistryVerses(registry, translationId, voiceSlug) {
  let count = 0;
  const books = registry.translations?.[translationId]?.voices?.[voiceSlug]?.books || {};
  for (const book of Object.values(books)) {
    for (const chapter of Object.values(book.chapters || {})) {
      count += Object.keys(chapter.verses || {}).length;
    }
  }
  return count;
}

function updateRegistry(registry, entry) {
  const { translationId, voiceSlug, bookId, chapter, verse, relPath, bytes } = entry;
  registry.translations ??= {};
  registry.translations[translationId] ??= { voices: {} };
  const t = registry.translations[translationId];
  t.voices[voiceSlug] ??= { books: {}, verseCount: 0 };
  const v = t.voices[voiceSlug];
  v.books[bookId] ??= { chapters: {} };
  const b = v.books[bookId];
  b.chapters[String(chapter)] ??= { verses: {} };
  b.chapters[String(chapter)].verses[String(verse)] = {
    status: 'done',
    path: relPath,
    url: versePublicUrl(relPath),
    bytes,
    generatedAt: new Date().toISOString(),
  };
  v.verseCount = countRegistryVerses(registry, translationId, voiceSlug);
  registry.updatedAt = new Date().toISOString();
}

async function main() {
  const args = parseArgs(process.argv);
  const voicesConfig = loadJson(VOICES_PATH);
  if (!voicesConfig) throw new Error(`Missing ${VOICES_PATH}`);

  const { voices, translations } = resolveJobs(voicesConfig, args);
  let registry = loadJson(REGISTRY_PATH, {
    version: 1,
    updatedAt: null,
    publicBasePath: '/audio/generated',
    translations: {},
  });

  console.log('Voices:', voices.map((v) => v.slug).join(', '));
  console.log('Translations:', translations.map((t) => t.id).join(', '));
  console.log('Output:', GENERATED_ROOT);

  let totalGenerated = 0;

  for (const translation of translations) {
    const bibleData = await fetchTranslationData(translation.id);
    const queue = buildWorkQueue(bibleData, args);
    console.log(`${translation.id}: ${queue.length} verses in scope`);

    if (args.dryRun) {
      for (const voice of voices) {
        console.log(`  [dry-run] ${voice.slug} × ${translation.id} → ${queue.length} MP3s`);
        if (queue[0]) {
          const sample = queue[0];
          const rel = verseRelPath(translation.id, voice.slug, sample.bookId, sample.chapter, sample.verse);
          console.log(`    sample: ${rel}`);
          console.log(`    text: "${sample.text.slice(0, 80)}..."`);
        }
      }
    } else {

    for (const voice of voices) {
      console.log(`\n▶ ${voice.slug} / ${translation.id}`);
      let done = 0;
      let skipped = 0;

      for (const item of queue) {
        if (args.limit != null && totalGenerated >= args.limit) {
          console.log('Limit reached.');
          saveJson(REGISTRY_PATH, registry);
          return;
        }

        const rel = verseRelPath(translation.id, voice.slug, item.bookId, item.chapter, item.verse);
        const abs = path.join(GENERATED_ROOT, rel);

        const inRegistry = args.resume && registryHasVerse(
          registry, translation.id, voice.slug, item.bookId, item.chapter, item.verse
        );
        const onDisk = fs.existsSync(abs) && fs.statSync(abs).size > 500;

        if (!args.force && (inRegistry || onDisk)) {
          skipped++;
          continue;
        }

        const bookMeta = findBook(item.bookId);
        const prefix = bookMeta ? `${bookMeta.name} chapter ${item.chapter}, verse ${item.verse}. ` : '';
        const speakText = `${prefix}${item.text}`;

        try {
          fs.mkdirSync(path.dirname(abs), { recursive: true });
          const audio = await synthesize(voice, speakText, { language: translation.language || 'en' });
          fs.writeFileSync(abs, audio);

          updateRegistry(registry, {
            translationId: translation.id,
            voiceSlug: voice.slug,
            bookId: item.bookId,
            chapter: item.chapter,
            verse: item.verse,
            relPath: rel,
            bytes: audio.length,
          });

          done++;
          totalGenerated++;
          if (done % 25 === 0) {
            saveJson(REGISTRY_PATH, registry);
            console.log(`  ${item.bookId} ${item.chapter}:${item.verse} (${done} new, ${skipped} skipped)`);
          }
          await sleep(args.delayMs);
        } catch (err) {
          console.error(`  ✗ ${rel}: ${err.message}`);
          saveJson(REGISTRY_PATH, registry);
          throw err;
        }
      }

      saveJson(REGISTRY_PATH, registry);
      console.log(`  Done: ${done} generated, ${skipped} skipped`);
    }
    }
  }

  if (!args.dryRun) {
    saveJson(REGISTRY_PATH, registry);
    console.log('\nRegistry saved:', REGISTRY_PATH);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});