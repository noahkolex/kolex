// Meta (Facebook) Pixel — bootstraps fbq and fires PageView on every page.
// Centralised so the pixel ID lives in exactly one place: change or remove this
// file to update it. Skipped on localhost so dev/test traffic never pollutes the
// pixel (and never reaches connect.facebook.net from a local machine).
(function () {
  var h = location.hostname;
  if (h === "localhost" || h === "127.0.0.1" || h === "0.0.0.0" || h === "::1") return;
  !(function (f, b, e, v, n, t, s) {
    if (f.fbq) return;
    n = f.fbq = function () {
      n.callMethod ? n.callMethod.apply(n, arguments) : n.queue.push(arguments);
    };
    if (!f._fbq) f._fbq = n;
    n.push = n;
    n.loaded = !0;
    n.version = "2.0";
    n.queue = [];
    t = b.createElement(e);
    t.async = !0;
    t.src = v;
    s = b.getElementsByTagName(e)[0];
    s.parentNode.insertBefore(t, s);
  })(window, document, "script", "https://connect.facebook.net/en_US/fbevents.js");
  fbq("init", "1749654623135729");
  fbq("track", "PageView");
})();
