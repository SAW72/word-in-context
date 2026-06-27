/**
 * Pre-generated Bible audio — catalog + MP3 playback with browser TTS fallback.
 */
(function (global) {
  'use strict';

  const PREGEN_PREFIX = 'mp3:';
  let catalog = null;
  let catalogPromise = null;
  let currentAudio = null;

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

  function pregenSlug(voiceId) {
    return String(voiceId || '').replace(/^mp3:/, '');
  }

  function toPregenVoiceId(slug) {
    return `${PREGEN_PREFIX}${slug}`;
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

  function stopMp3() {
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

  function playMp3(url) {
    return new Promise((resolve, reject) => {
      stopMp3();
      const audio = new Audio(url);
      currentAudio = audio;
      audio.onended = () => resolve('ended');
      audio.onerror = () => reject(new Error('MP3 playback failed'));
      const p = audio.play();
      if (p && typeof p.catch === 'function') p.catch(reject);
    });
  }

  global.AudioEngine = {
    PREGEN_PREFIX,
    loadCatalog,
    isPregenVoice,
    pregenSlug,
    toPregenVoiceId,
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