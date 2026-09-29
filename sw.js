// The landing page's service worker: the page opens offline once "Save for offline" has stored
// it (in the cache pyfig-saved, with the notes). The reader has its own (reader/sw.js), which
// answers for the reader's pages; this one covers the rest of the site, and the reader too
// until the reader's own is running. Online, everything comes from the network as usual.
const SAVED = "pyfig-saved";
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));
self.addEventListener("fetch", (e) => {
  const req = e.request, url = new URL(req.url);
  if (req.method !== "GET" || req.headers.has("range") || url.pathname.endsWith(".zip")) return;
  if (url.hostname === "cdn.jsdelivr.net") {            // PDF.js: versioned addresses, saved copy first
    e.respondWith(caches.match(req).then((hit) => hit || fetch(req)));
    return;
  }
  if (url.origin !== location.origin) return;
  e.respondWith(fetch(req).then(async (res) => {
    if (res.ok && res.status === 200) {                  // keep a saved copy up to date
      const c = await caches.open(SAVED);
      if (await c.match(req, { ignoreSearch: true })) await c.put(req, res.clone());
    }
    return res;
  }).catch(async () => (await caches.match(req, { ignoreSearch: !url.pathname.includes("/videos/") }))
    || (await caches.match(req.url.split("?")[0], { ignoreSearch: true })) || Response.error()));
});
