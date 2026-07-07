// シンプルなキャッシュ(アプリの殻だけ。データは常にネット経由)
const CACHE = "kyou-yaru-v18";

self.addEventListener("message", (e) => {
  if (e.data === "skip") self.skipWaiting();
});
const SHELL = ["./", "index.html", "style.css", "app.js", "config.js", "manifest.webmanifest"];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)));
  self.skipWaiting();
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
  );
});

self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (url.origin !== location.origin) return; // SupabaseやCDNはキャッシュしない
  e.respondWith(
    fetch(e.request)
      .then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(e.request, copy));
        return res;
      })
      .catch(() => caches.match(e.request))
  );
});
