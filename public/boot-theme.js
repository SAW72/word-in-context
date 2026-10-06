/* Early paint flags. data-boot selects which flags this page used inline. */
(function () {
  var script = document.currentScript;
  var flags = (script && script.getAttribute('data-boot')) || '';
  var wantTheme = flags.indexOf('theme') !== -1;
  var wantIos = flags.indexOf('ios') !== -1;
  try {
    if (wantTheme && localStorage.getItem('dark_mode') === 'true') {
      document.documentElement.setAttribute('data-theme', 'dark');
    }
    if (wantIos) {
      var ios = /iPad|iPhone|iPod/i.test(navigator.userAgent)
        || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
      var standalone = window.matchMedia('(display-mode: standalone)').matches
        || window.navigator.standalone === true;
      if (ios) document.documentElement.classList.add('ios');
      if (standalone) document.documentElement.classList.add('standalone-app');
    }
  } catch (e) {}
})();
