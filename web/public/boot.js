/*
 * Boot guard (classic script, so the strict CSP's script-src 'self' allows it).
 *
 * After an update a browser that kept an old index.html asks for a bundle name that no longer exists. The module then
 * never runs and the boot splash stays on screen forever. Reload once with a cache-busting query to fetch the current
 * index.html; the second attempt carries ?boot=…, so a genuinely broken build cannot loop.
 */
(function () {
  var module = document.querySelector('script[type="module"]');

  function retry() {
    var url = new URL(location.href);
    if (url.searchParams.has('boot')) return;
    url.searchParams.set('boot', String(Date.now()));
    location.replace(url.toString());
  }

  if (module) module.addEventListener('error', retry);
  setTimeout(function () {
    if (document.querySelector('#root .boot')) retry();
  }, 8000);
})();
