/* Word in Context — PWA install prompt + service worker registration */
(function () {
  function ensurePwaStyles() {
    if (document.getElementById('pwa-inline-styles')) return;
    const style = document.createElement('style');
    style.id = 'pwa-inline-styles';
    style.textContent = `
html.ios.standalone-app{--safe-top:env(safe-area-inset-top,0px);--safe-right:env(safe-area-inset-right,0px);--safe-bottom:env(safe-area-inset-bottom,0px);--safe-left:env(safe-area-inset-left,0px)}
html.ios.standalone-app body{min-height:100dvh;min-height:-webkit-fill-available}
html.ios.standalone-app #pwa-offline-badge.visible{padding-top:calc(6px + var(--safe-top))}
#pwa-install-banner{position:fixed;left:12px;right:12px;bottom:12px;z-index:10000;display:none;align-items:center;gap:12px;padding:14px 16px;background:#2c3e50;color:#f8f5f2;border-radius:14px;box-shadow:0 8px 32px rgba(0,0,0,.28);font-family:system-ui,-apple-system,sans-serif;font-size:14px;line-height:1.35;animation:pwa-slide-up .35s ease-out}
#pwa-install-banner.visible{display:flex}
#pwa-install-banner .pwa-icon{width:44px;height:44px;border-radius:10px;flex-shrink:0}
#pwa-install-banner .pwa-copy{flex:1;min-width:0}
#pwa-install-banner .pwa-copy strong{display:block;font-size:15px;margin-bottom:2px}
#pwa-install-banner .pwa-copy span{opacity:.88;font-size:12px}
#pwa-install-banner .pwa-actions{display:flex;flex-direction:column;gap:6px;flex-shrink:0}
#pwa-install-banner button{border:none;border-radius:8px;padding:8px 14px;font-size:13px;font-weight:600;cursor:pointer;white-space:nowrap}
#pwa-install-install{background:#c9a227;color:#1a252f}
#pwa-install-dismiss{background:transparent;color:#f8f5f2;opacity:.75;font-weight:500;padding:4px 8px}
#pwa-offline-badge{position:fixed;top:0;left:0;right:0;z-index:9999;display:none;text-align:center;padding:6px 12px;background:#8b5e3c;color:#fff;font-size:12px;font-weight:600;letter-spacing:.03em;font-family:system-ui,-apple-system,sans-serif}
#pwa-offline-badge.visible{display:block}
@keyframes pwa-slide-up{from{transform:translateY(24px);opacity:0}to{transform:translateY(0);opacity:1}}
@media (max-width:480px){#pwa-install-banner{flex-wrap:wrap;left:max(12px,env(safe-area-inset-left,0px));right:max(12px,env(safe-area-inset-right,0px));bottom:max(12px,env(safe-area-inset-bottom,0px))}#pwa-install-banner .pwa-actions{flex-direction:row;width:100%;justify-content:flex-end}}
`;
    document.head.appendChild(style);
  }

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
    ensurePwaStyles();

    const banner = document.createElement('div');
    banner.id = 'pwa-install-banner';
    banner.setAttribute('role', 'dialog');
    banner.setAttribute('aria-label', 'Install app');
    banner.innerHTML = `
      <img class="pwa-icon" src="/icons/icon-192.png?v=cross4" alt="" width="44" height="44">
      <div class="pwa-copy">
        <strong>Install The Word in Context</strong>
        <span id="pwa-install-subtitle">Voice-first offline Bible study with AI.</span>
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
    ensurePwaStyles();
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