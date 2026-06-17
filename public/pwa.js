/* Word in Context — PWA install prompt + service worker registration */
(function () {
  const INSTALL_KEY = 'wic_pwa_install_dismissed';
  const INSTALLED_KEY = 'wic_pwa_installed';
  let deferredPrompt = null;

  function applyPlatformClasses() {
    const root = document.documentElement;
    if (isIOS()) root.classList.add('ios');
    if (isStandalone()) root.classList.add('standalone-app');
  }

  function isStandalone() {
    return window.matchMedia('(display-mode: standalone)').matches
      || window.navigator.standalone === true;
  }

  function isIOS() {
    return /iPad|iPhone|iPod/i.test(navigator.userAgent)
      || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  }

  function shouldShowInstall() {
    if (isStandalone()) return false;
    if (localStorage.getItem(INSTALLED_KEY) === 'true') return false;
    if (localStorage.getItem(INSTALL_KEY) === 'true') return false;
    return true;
  }

  function createBanner() {
    if (document.getElementById('pwa-install-banner')) return;

    const banner = document.createElement('div');
    banner.id = 'pwa-install-banner';
    banner.setAttribute('role', 'dialog');
    banner.setAttribute('aria-label', 'Install app');
    banner.innerHTML = `
      <img class="pwa-icon" src="/icons/icon-192.png?v=cross2" alt="" width="44" height="44">
      <div class="pwa-copy">
        <strong>Install The Word in Context</strong>
        <span id="pwa-install-subtitle">Voice-first offline Bible study with John.</span>
      </div>
      <div class="pwa-actions">
        <button type="button" id="pwa-install-install">Install</button>
        <button type="button" id="pwa-install-dismiss">Not now</button>
      </div>
    `;
    document.body.appendChild(banner);

    const subtitle = document.getElementById('pwa-install-subtitle');
    if (isIOS() && !deferredPrompt) {
      subtitle.textContent = 'Tap Share, then "Add to Home Screen" for the full app experience.';
      document.getElementById('pwa-install-install').textContent = 'Got it';
    }

    document.getElementById('pwa-install-dismiss').onclick = () => {
      localStorage.setItem(INSTALL_KEY, 'true');
      banner.classList.remove('visible');
    };

    document.getElementById('pwa-install-install').onclick = async () => {
      if (deferredPrompt) {
        deferredPrompt.prompt();
        const { outcome } = await deferredPrompt.userChoice;
        deferredPrompt = null;
        if (outcome === 'accepted') {
          localStorage.setItem(INSTALLED_KEY, 'true');
          banner.classList.remove('visible');
        }
      } else {
        localStorage.setItem(INSTALL_KEY, 'true');
        banner.classList.remove('visible');
      }
    };
  }

  function showInstallBanner() {
    if (!shouldShowInstall()) return;
    createBanner();
    const banner = document.getElementById('pwa-install-banner');
    if (banner) banner.classList.add('visible');
  }

  function setupOfflineBadge() {
    if (document.getElementById('pwa-offline-badge')) return;
    const badge = document.createElement('div');
    badge.id = 'pwa-offline-badge';
    badge.textContent = 'Offline Mode';
    badge.setAttribute('aria-label', 'Offline Mode — cached Bible text available; AI study needs internet');
    document.body.appendChild(badge);

    function update() {
      badge.classList.toggle('visible', !navigator.onLine);
    }
    window.addEventListener('online', update);
    window.addEventListener('offline', update);
    update();
  }

  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferredPrompt = e;
    if (shouldShowInstall()) showInstallBanner();
  });

  window.addEventListener('appinstalled', () => {
    localStorage.setItem(INSTALLED_KEY, 'true');
    const banner = document.getElementById('pwa-install-banner');
    if (banner) banner.classList.remove('visible');
  });

  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('/sw.js', { scope: '/' }).catch((err) => {
        console.warn('[PWA] service worker registration failed:', err);
      });
    });
  }

  applyPlatformClasses();

  window.addEventListener('load', () => {
    applyPlatformClasses();
    setupOfflineBadge();
    if (isStandalone()) {
      localStorage.setItem(INSTALLED_KEY, 'true');
      return;
    }
    setTimeout(() => {
      if (shouldShowInstall()) showInstallBanner();
    }, 1800);
  });
})();