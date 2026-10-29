const CACHE_NAME = "servitech-shell-v1";
const APP_SHELL = [
  "/",
  "/styles.css",
  "/app.js",
  "/manifest.webmanifest",
  "/icons/icon-192.svg",
  "/icons/icon-512.svg",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => cache.addAll(APP_SHELL))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((cacheNames) => Promise.all(
        cacheNames
          .filter((cacheName) => cacheName.startsWith("servitech-shell-") && cacheName !== CACHE_NAME)
          .map((cacheName) => caches.delete(cacheName)),
      ))
      .then(() => self.clients.claim()),
  );
});

async function staleWhileRevalidate(request) {
  const cache = await caches.open(CACHE_NAME);
  const cachedResponse = await cache.match(request);
  const networkResponse = fetch(request).then(async (response) => {
    if (response.ok && response.type === "basic") {
      await cache.put(request, response.clone());
    }
    return response;
  });

  if (cachedResponse) {
    void networkResponse.catch((error) => {
      console.error("No se pudo actualizar el recurso en caché:", error);
    });
    return cachedResponse;
  }
  return networkResponse;
}

self.addEventListener("fetch", (event) => {
  const requestUrl = new URL(event.request.url);
  if (event.request.method !== "GET" || requestUrl.origin !== self.location.origin) {
    return;
  }

  if (requestUrl.pathname.startsWith("/api/")) {
    event.respondWith(
      fetch(event.request).catch(() => new Response(
        JSON.stringify({
          error: {
            code: "OFFLINE",
            message: "El servidor no está disponible. El reporte permanece guardado en este dispositivo.",
          },
        }),
        {
          status: 503,
          headers: { "Content-Type": "application/json; charset=utf-8" },
        },
      )),
    );
    return;
  }

  event.respondWith(
    staleWhileRevalidate(event.request).catch(async (error) => {
      if (event.request.mode === "navigate") {
        const offlinePage = await caches.match("/");
        if (offlinePage) {
          return offlinePage;
        }
      }
      throw error;
    }),
  );
});
