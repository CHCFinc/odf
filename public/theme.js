// Runs before the page draws, so a saved Light or Dark choice applies without a flash.
(function () {
  try {
    var t = localStorage.getItem('odf-theme');
    if (t === 'light' || t === 'dark') document.documentElement.setAttribute('data-theme', t);
  } catch (e) { /* no saved choice: follow the device */ }
})();
