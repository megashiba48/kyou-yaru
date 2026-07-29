// シンプルなキャッシュ(アプリの殻だけ。データは常にネット経由)
const CACHE = "kyou-yaru-v31";

// index.html の ?v= と必ず同じ値にする。ズレると端末が古いJSを掴んだままになる。
const V = "6.8";

self.addEventListener("message", (e) => {
  if (e.data === "skip") self.skipWaiting();
});
const SHELL = ["./", "index.html", `style.css?v=${V}`, `app.js?v=${V}`, "config.js", "manifest.webmanifest"];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)));
  self.skipWaiting();
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()) // 新しいSWが即座に主導権を取る(開き直し1回で反映される)
  );
});

self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (url.origin !== location.origin) return; // SupabaseやCDNはキャッシュしない
  // index.html だけはブラウザのHTTPキャッシュを迂回して必ず取り直す。
  // ここが ?v= の起点なので、HTMLが古いと他も全部古いまま固定される(2026-07-29の事故)。
  const isDoc = e.request.mode === "navigate" || url.pathname.endsWith("/") || url.pathname.endsWith("index.html");
  const net = isDoc ? fetch(url.href, { cache: "reload" }) : fetch(e.request);
  e.respondWith(
    net
      .then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(e.request, copy));
        return res;
      })
      .catch(() => caches.match(e.request))
  );
});
