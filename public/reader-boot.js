/* Promote print-media stylesheets after load, and register the service worker.
   Replaces the inline onload handlers and the inline register script. */
(function () {
  function promote(id) {
    var link = document.getElementById(id);
    if (!link) return;
    function apply() { link.media = 'all'; }
    if (link.sheet) apply();
    else link.addEventListener('load', apply);
  }
  promote('reader-css');
  promote('reader-fonts');
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/sw.js').catch(function () {});
  }
})();
