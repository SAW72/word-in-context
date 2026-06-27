/* Word in Context — service worker (app shell + Bible JSON offline cache) */
const CACHE_VERSION = 'wic-pwa-49';
const SHELL_CACHE = `${CACHE_VERSION}-shell`;
const BIBLE_CACHE = `${CACHE_VERSION}-bible`;

const BIBLE_ORIGIN = 'https://bible.helloao.org';

const SHELL_URLS = [
  '/',
  '/app',
  '/read',
  '/reader.html',
  '/reader.css',
  '/reader.js',
  '/audio-engine.js',
  '/voice-picker.js',
  '/study-core.js',
  '/bible-core.js',
  '/admin',
  '/index.html',
  '/landing.html',
  '/instructions.html',
  '/admin.html',
  '/manifest.webmanifest',
  '/manifest.webmanifest?v=cross4',
  '/pwa.js',
  '/pwa.css',
  '/john-popup.js',
  '/auth-api.js',
  '/icons/icon.svg',
  '/icons/icon-192.png',
  '/icons/icon-192.png?v=cross4',
  '/icons/icon-512.png',
  '/icons/icon-512.png?v=cross4',
  '/icons/icon-maskable-512.png',
  '/icons/icon-maskable-512.png?v=cross4',
  '/icons/share-og.png',
  '/data/study-lexicon.json',
];

function biblePrecacheUrls() {
  return [
    '/api/available_translations.json',
    '/api/BSB/books.json',
    '/api/BSB/complete.json',
    '/api/grc_sbl/complete.json',
    '/api/hbo_wlc/complete.json',
    '/api/grc_bre/complete.json',
    '/api/BSB/GEN/1.json',
    '/api/BSB/PSA/23.json',
    '/api/BSB/ROM/8.json',
    '/api/BSB/JHN/3.json',
    '/api/grc_sbl/JHN/3.json',
    '/api/hbo_wlc/GEN/1.json',
  ];
}

const BIBLE_PRECACHE = biblePrecacheUrls();

async function cacheUrls(cache, urls) {
  const batchSize = 40;
  for (let i = 0; i < urls.length; i += batchSize) {
    const batch = urls.slice(i, i + batchSize);
    await Promise.allSettled(batch.map(async (url) => {
      try {
        const res = await fetch(url, { cache: 'reload' });
        if (res.ok) await cache.put(url, res);
      } catch (e) {
        console.warn('[SW] precache failed:', url, e);
      }
    }));
  }
}

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const shell = await caches.open(SHELL_CACHE);
    await cacheUrls(shell, SHELL_URLS);

    const bible = await caches.open(BIBLE_CACHE);
    await cacheUrls(bible, BIBLE_PRECACHE.map((p) => `${BIBLE_ORIGIN}${p}`));

    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(
      keys
        .filter((k) => !k.startsWith(CACHE_VERSION))
        .map((k) => caches.delete(k))
    );
    await self.clients.claim();
  })());
});

async function bibleResponse(request) {
  const cache = await caches.open(BIBLE_CACHE);
  const cached = await cache.match(request);
  try {
    const network = await fetch(request);
    if (network.ok) await cache.put(request, network.clone());
    return network;
  } catch (err) {
    if (cached) return cached;
    return new Response(JSON.stringify({ error: 'Bible text unavailable offline' }), {
      status: 503,
      headers: { 'Content-Type': 'application/json' },
    });
  }
}

async function shellResponse(request) {
  const cache = await caches.open(SHELL_CACHE);
  const cached = await cache.match(request);
  try {
    const network = await fetch(request);
    if (network.ok) await cache.put(request, network.clone());
    return network;
  } catch (err) {
    return cached;
  }
}

async function navigationResponse(request) {
  try {
    const network = await fetch(request);
    const cache = await caches.open(SHELL_CACHE);
    if (network.ok) await cache.put(request, network.clone());
    return network;
  } catch (err) {
    const cache = await caches.open(SHELL_CACHE);
    const path = new URL(request.url).pathname;
    if (path === '/' || path === '') {
      return (await cache.match('/landing.html')) || (await cache.match('/')) || (await cache.match('/app'));
    }
    if (path.startsWith('/app')) {
      return (await cache.match('/app')) || (await cache.match('/index.html'));
    }
    if (path.startsWith('/admin')) {
      return (await cache.match('/admin')) || (await cache.match('/admin.html'));
    }
    return (await cache.match(path)) || (await cache.match('/app')) || (await cache.match('/index.html'));
  }
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);

  if (url.origin === BIBLE_ORIGIN && url.pathname.startsWith('/api/')) {
    event.respondWith(bibleResponse(request));
    return;
  }

  if (url.origin === self.location.origin && url.pathname.startsWith('/api/')) {
    event.respondWith(
      fetch(request).catch(() => {
        const offline = { error: 'You are offline. The app shell and cached Bible text are available, but AI study needs internet.' };
        return new Response(JSON.stringify(offline), {
          status: 503,
          headers: { 'Content-Type': 'application/json' },
        });
      })
    );
    return;
  }

  if (request.mode === 'navigate') {
    event.respondWith(navigationResponse(request));
    return;
  }

  if (url.origin === self.location.origin) {
    const isStatic = /\.(html|css|js|json|png|svg|jpg|jpeg|webp|webmanifest)$/i.test(url.pathname)
      || url.pathname === '/sw.js';
    if (isStatic) {
      event.respondWith(shellResponse(request));
    }
  }
});