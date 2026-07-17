const CACHE = "pagetree-v22";
const CORE = ["./", "./index.html", "./style.css", "./app.js", "./config.js", "./manifest.json"];
const OPTIONAL = ["./icons/icon-192.png", "./icons/icon-512.png"];

self.addEventListener("install", e => {
  e.waitUntil(
    caches.open(CACHE).then(async c => {
      await c.addAll(CORE);
      await Promise.all(OPTIONAL.map(url => c.add(url).catch(() => {})));
    }).then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
      .then(() => self.clients.matchAll({ type: "window" }))
      .then(clients => clients.forEach(c => c.postMessage({ type: "pagetree-updated", cache: CACHE })))
  );
});

function isAppShell(url) {
  const p = url.pathname;
  return (
    p.endsWith("/") ||
    p.endsWith("/index.html") ||
    p.endsWith("/app.js") ||
    p.endsWith("/config.js") ||
    p.endsWith("/style.css") ||
    p.endsWith("/sw.js") ||
    p.endsWith("/manifest.json")
  );
}

self.addEventListener("fetch", e => {
  if (e.request.method !== "GET") return;
  const url = new URL(e.request.url);
  if (url.origin !== self.location.origin) return;

  // Always prefer network for the app shell so map/app fixes are not stuck in cache.
  if (isAppShell(url)) {
    e.respondWith(
      fetch(e.request).then(res => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then(c => c.put(e.request, copy));
        }
        return res;
      }).catch(() => caches.match(e.request).then(hit => hit || caches.match("./index.html")))
    );
    return;
  }

  e.respondWith(
    caches.match(e.request).then(hit => hit || fetch(e.request).then(res => {
      const copy = res.clone();
      caches.open(CACHE).then(c => c.put(e.request, copy));
      return res;
    }).catch(() => caches.match("./index.html")))
  );
});
