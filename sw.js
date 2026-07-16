const CACHE = "pagetree-v15";
const CORE = ["./", "./index.html", "./style.css", "./app.js", "./manifest.json"];
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
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener("fetch", e => {
  if (e.request.method !== "GET") return;
  e.respondWith(
    caches.match(e.request).then(hit => hit || fetch(e.request).then(res => {
      const copy = res.clone();
      caches.open(CACHE).then(c => c.put(e.request, copy));
      return res;
    }).catch(() => caches.match("./index.html")))
  );
});
