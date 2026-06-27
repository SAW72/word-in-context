/**
 * Shared English voice categorization — matches Bible reader Settings layout.
 */
(function (global) {
  'use strict';

  function isReaderOnlyVoiceId(id) {
    return /^(helloao:|mp3:)/.test(String(id || ''));
  }

  function findVoiceByName(name, voices) {
    if (!name || isReaderOnlyVoiceId(name)) return null;
    const norm = String(name).replace(/\s*\(System\)\s*$/i, '').trim();
    return (voices || []).find((v) => v.name === name)
      || (voices || []).find((v) => v.name === norm)
      || (voices || []).find((v) => v.name.toLowerCase().includes(norm.toLowerCase()));
  }

  function categorizeEnglishVoices(voices, savedName, findFn) {
    const english = (voices || []).filter((v) => (v.lang || '').toLowerCase().startsWith('en'));
    const resolve = findFn || ((name) => findVoiceByName(name, english));
    const saved = savedName && !isReaderOnlyVoiceId(savedName) ? resolve(savedName) : null;
    const personal = english.filter((v) => /personal|cloned/i.test(v.name));
    const enhanced = english.filter((v) => /enhanced|premium|neural|google uk|google us/i.test(v.name));
    const grokStyle = english.filter((v) =>
      /daniel|samantha|alex|karen|fred|aaron|nicky/i.test(v.name) && !enhanced.includes(v)
    );
    const used = new Set([saved, ...personal, ...enhanced, ...grokStyle].filter(Boolean));
    const other = english.filter((v) => !used.has(v));
    return { saved, personal, enhanced, grokStyle, other, all: english };
  }

  function appendDeviceVoiceGroups(select, cats, opts) {
    if (!select || !cats) return;
    const getValue = opts.getValue || ((v) => v.name);
    const getLabel = opts.getLabel || ((v) => v.name);
    const selectedValue = opts.selectedValue || '';

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
        const val = getValue(v);
        opt.value = val;
        opt.textContent = getLabel(v);
        if (val === selectedValue) opt.selected = true;
        og.appendChild(opt);
      });
      select.appendChild(og);
    });
  }

  function appendReaderAudioGroups(select, opts) {
    if (!select) return;
    const disabled = opts?.disabled !== false;
    const AE = global.AudioEngine;

    if (AE && opts?.helloao !== false) {
      const og = document.createElement('optgroup');
      og.label = disabled
        ? '— BSB Audio (Read app · chapter play) —'
        : '— BSB Audio (free) —';
      (AE.HELLOAO_BSB_NARRATORS || []).forEach((n) => {
        const opt = document.createElement('option');
        opt.value = disabled ? '' : AE.toHelloaoVoiceId(n.slug);
        opt.textContent = n.label;
        if (disabled) opt.disabled = true;
        og.appendChild(opt);
      });
      if (og.children.length) select.appendChild(og);
    }

    const catalog = opts?.catalog;
    const studioVoices = catalog?.voices || [];
    if (studioVoices.length && opts?.studio !== false) {
      const og = document.createElement('optgroup');
      og.label = disabled
        ? '— Studio voices (Read app) —'
        : `— Studio (${opts.translationId || 'BSB'}) —`;
      studioVoices.forEach((v) => {
        const opt = document.createElement('option');
        opt.value = disabled ? '' : AE.toPregenVoiceId(v.slug);
        opt.textContent = v.label;
        if (disabled) opt.disabled = true;
        og.appendChild(opt);
      });
      select.appendChild(og);
    }
  }

  global.VoicePicker = {
    isReaderOnlyVoiceId,
    findVoiceByName,
    categorizeEnglishVoices,
    appendDeviceVoiceGroups,
    appendReaderAudioGroups
  };
})(typeof window !== 'undefined' ? window : globalThis);