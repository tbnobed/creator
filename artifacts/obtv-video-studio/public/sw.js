const CACHE_NAME = "obtv-creator-ai-shell-v2";

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => cache.add("./"))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))),
    ).then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET" || new URL(event.request.url).origin !== self.location.origin) return;
  // Never intercept API, media, range requests, or static assets. Only the
  // document navigation has an app-shell offline fallback.
  const pathname = new URL(event.request.url).pathname;
  if (event.request.mode !== "navigate" || pathname.endsWith("/api") || pathname.includes("/api/")
    || /\.(mp4|mov|webm|mp3|wav|png|jpe?g|webp|gif)$/i.test(pathname)
    || event.request.headers.has("range")) return;

  event.respondWith(
    fetch(event.request)
      .then((response) => {
        if (response.ok && event.request.mode === "navigate") {
          const copy = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy));
        }
        return response;
      })
      .catch(() => caches.match(event.request).then((cached) => cached || caches.match("./"))),
  );
});