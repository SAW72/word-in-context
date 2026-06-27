/**
 * Bible audio — helloao BSB narrators, pre-generated MP3s, playback helpers.
 */
(function (global) {
  'use strict';

  const PREGEN_PREFIX = 'mp3:';
  const HELLOAO_PREFIX = 'helloao:';
  const HELLOAO_AUDIO_ORIGIN = 'https://audio.bible.helloao.org/api';

  const HELLOAO_BSB_NARRATORS = [
    { slug: 'david', label: 'David' },
    { slug: 'hays', label: 'Hays' },
    { slug: 'souer', label: 'Souer' }
  ];

  let catalog = null;
  let catalogPromise = null;
  let currentAudio = null;
  let progressCallback = null;

  function loadCatalog() {
    if (catalog) return Promise.resolve(catalog);
    if (catalogPromise) return catalogPromise;
    catalogPromise = fetch('/api/audio/catalog')
      .then((r) => (r.ok ? r.json() : { voices: [], availability: [] }))
      .then((data) => {
        catalog = data || { voices: [], availability: [] };
        return catalog;
      })
      .catch(() => {
        catalog = { voices: [], availability: [] };
        return catalog;
      });
    return catalogPromise;
  }

  function isPregenVoice(voiceId) {
    return String(voiceId || '').startsWith(PREGEN_PREFIX);
  }

  function isHelloaoVoice(voiceId) {
    return String(voiceId || '').startsWith(HELLOAO_PREFIX);
  }

  function pregenSlug(voiceId) {
    return String(voiceId || '').replace(/^mp3:/, '');
  }

  function helloaoSlug(voiceId) {
    return String(voiceId || '').replace(/^helloao:/, '');
  }

  function toPregenVoiceId(slug) {
    return `${PREGEN_PREFIX}${slug}`;
  }

  function toHelloaoVoiceId(slug) {
    return `${HELLOAO_PREFIX}${slug}`;
  }

  function helloaoChapterUrl(translationId, bookCode, chapter, narratorSlug, links) {
    if (links && links[narratorSlug]) return links[narratorSlug];
    if (translationId !== 'BSB') return null;
    return `${HELLOAO_AUDIO_ORIGIN}/BSB/${bookCode}/${chapter}/audio/${narratorSlug}.mp3`;
  }

  function verseUrl(translationId, voiceSlug, bookCode, chapter, verse) {
    const ch = String(chapter).padStart(3, '0');
    const v = String(verse).padStart(3, '0');
    return `/audio/generated/${translationId}/${voiceSlug}/${bookCode}/${ch}/${v}.mp3`;
  }

  function availabilityFor(translationId, voiceSlug) {
    if (!catalog || !Array.isArray(catalog.availability)) return null;
    return catalog.availability.find((a) => a.translationId === translationId && a.voiceSlug === voiceSlug) || null;
  }

  function hasAnyAudio(translationId, voiceSlug) {
    const row = availabilityFor(translationId, voiceSlug);
    return !!(row && row.verseCount > 0);
  }

  function availablePregenVoices(translationId) {
    if (!catalog) return [];
    const slugs = new Set(
      (catalog.availability || [])
        .filter((a) => a.translationId === translationId && a.verseCount > 0)
        .map((a) => a.voiceSlug)
    );
    return (catalog.voices || []).filter((v) => slugs.has(v.slug));
  }

  function allCatalogVoices() {
    return (catalog && catalog.voices) || [];
  }

  function detachProgress() {
    if (!currentAudio || !progressCallback) return;
    currentAudio.removeEventListener('timeupdate', progressCallback);
    progressCallback = null;
  }

  function stopMp3() {
    detachProgress();
    if (!currentAudio) return;
    currentAudio.pause();
    currentAudio.removeAttribute('src');
    currentAudio.load();
    currentAudio = null;
  }

  function pauseMp3() {
    if (currentAudio && !currentAudio.paused) currentAudio.pause();
  }

  function resumeMp3() {
    if (currentAudio && currentAudio.paused) return currentAudio.play();
    return Promise.resolve();
  }

  function isMp3Paused() {
    return !!(currentAudio && currentAudio.paused);
  }

  function isMp3Playing() {
    return !!(currentAudio && !currentAudio.paused && !currentAudio.ended);
  }

  function playMp3(url, handlers) {
    return new Promise((resolve, reject) => {
      stopMp3();
      const audio = new Audio(url);
      currentAudio = audio;

      if (handlers && typeof handlers.onTimeUpdate === 'function') {
        progressCallback = () => {
          const duration = audio.duration;
          if (!duration || !Number.isFinite(duration)) return;
          handlers.onTimeUpdate(audio.currentTime, duration);
        };
        audio.addEventListener('timeupdate', progressCallback);
      }

      audio.onended = () => {
        detachProgress();
        if (handlers && handlers.onEnd) handlers.onEnd();
        resolve('ended');
      };
      audio.onerror = () => {
        detachProgress();
        const err = new Error('MP3 playback failed');
        if (handlers && handlers.onError) handlers.onError(err);
        reject(err);
      };

      const p = audio.play();
      if (p && typeof p.catch === 'function') {
        p.catch((err) => {
          detachProgress();
          if (handlers && handlers.onError) handlers.onError(err);
          reject(err);
        });
      }
    });
  }

  global.AudioEngine = {
    PREGEN_PREFIX,
    HELLOAO_PREFIX,
    HELLOAO_BSB_NARRATORS,
    loadCatalog,
    isPregenVoice,
    isHelloaoVoice,
    pregenSlug,
    helloaoSlug,
    toPregenVoiceId,
    toHelloaoVoiceId,
    helloaoChapterUrl,
    verseUrl,
    availabilityFor,
    hasAnyAudio,
    availablePregenVoices,
    allCatalogVoices,
    stopMp3,
    pauseMp3,
    resumeMp3,
    isMp3Paused,
    isMp3Playing,
    playMp3
  };
})(typeof window !== 'undefined' ? window : globalThis);