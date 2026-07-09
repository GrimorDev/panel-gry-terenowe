const CACHE_NAME = "hufc-app-v7";
const APP_SHELL = [
  "/",
  "/index.html",
  "/manifest.webmanifest",
  "/icon-192.png",
  "/icon-512.png",
  "/icon-192.svg",
  "/icon-512.svg"
];

function isAppAsset(url) {
  return url.pathname.startsWith("/assets/")
    || /\.(js|css|png|jpg|jpeg|gif|webp|svg|ico|woff|woff2)$/i.test(url.pathname);
}

async function cacheUrls(urls) {
  const cache = await caches.open(CACHE_NAME);
  await Promise.all(
    [...new Set(urls)]
      .filter(Boolean)
      .map((url) => cache.add(url).catch(() => undefined))
  );
}

async function cacheAppShell() {
  const cache = await caches.open(CACHE_NAME);
  await cacheUrls(APP_SHELL);

  try {
    const response = await fetch("/index.html", { cache: "reload" });
    if (!response || !response.ok) return;

    const copy = response.clone();
    const html = await response.text();
    await cache.put("/", copy.clone());
    await cache.put("/index.html", copy);

    const assetUrls = [...html.matchAll(/(?:src|href)="([^"]+)"/g)]
      .map((match) => match[1])
      .filter((value) => value && (value.startsWith("/assets/") || value.startsWith("assets/")))
      .map((value) => value.startsWith("/") ? value : `/${value}`);

    await cacheUrls(assetUrls);
  } catch {
    // The app still has the previous shell if the network is unavailable while updating.
  }
}

self.addEventListener("install", (event) => {
  event.waitUntil(cacheAppShell().then(() => self.skipWaiting()));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("message", (event) => {
  if (event.data?.type === "SKIP_WAITING") {
    self.skipWaiting();
    return;
  }

  if (event.data?.type === "CACHE_URLS" && Array.isArray(event.data.urls)) {
    event.waitUntil(cacheUrls(event.data.urls));
  }
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin || url.pathname.startsWith("/api/")) return;

  if (request.mode === "navigate") {
    event.respondWith(
      fetch(request)
        .then((response) => {
          const copy = response.clone();
          caches.open(CACHE_NAME).then((cache) => {
            cache.put("/", copy.clone());
            cache.put("/index.html", copy);
          });
          return response;
        })
        .catch(() => caches.match("/index.html").then((cached) => cached || caches.match("/")))
    );
    return;
  }

  event.respondWith(
    caches.match(request).then((cached) => {
      if (cached) return cached;

      return fetch(request)
        .then((response) => {
          if (response && response.ok && isAppAsset(url)) {
            const copy = response.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(request, copy));
          }
          return response;
        })
        .catch(() => new Response("", { status: 504, statusText: "Offline" }));
    })
  );
});
