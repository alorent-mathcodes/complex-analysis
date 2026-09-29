// PyFig Reader's service worker: makes the reader installable, keeps it working offline, and
// receives PDFs shared to it on Android.
//  - the reader itself: from the network when online (so updates arrive), else the saved copy;
//  - PDF.js and Python from the CDN: saved on first use (their addresses carry a version, so a
//    saved copy never goes stale), which makes live figures work offline afterwards;
//  - recorded videos of figures (videos/NAME.mp4?h=HASH, next to a PDF): saved when first played,
//    not before; the hash in the address changes with the video, so a saved one is never stale.
//    Their list (videos/index.json) comes from the network when online, else the saved copy.
//  - files a website saved on purpose for offline reading (its "Save for offline" button puts
//    them, e.g. the PDF, in the cache pyfig-saved): kept up to date when fetched online.
const SHELL = "pyfig-shell-v1", CDN = "pyfig-cdn", SHARE = "pyfig-share", VIDEO = "pyfig-video", SAVED = "pyfig-saved";
const FILES = ["./", "./index.html", "./manifest.webmanifest", "./icon-192.png", "./icon-512.png"];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(SHELL).then((c) => c.addAll(FILES)));
  self.skipWaiting();
});
self.addEventListener("activate", (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(
    keys.filter((k) => ![SHELL, CDN, SHARE, VIDEO, SAVED].includes(k)).map((k) => caches.delete(k)))));
  self.clients.claim();
});

self.addEventListener("fetch", (e) => {
  const req = e.request, url = new URL(req.url);
  if (req.method === "POST" && url.origin === location.origin && url.pathname.endsWith("/share")) {
    e.respondWith(receiveShare(req));
  } else if (req.method !== "GET") {
    return;
  } else if (url.hostname === "cdn.jsdelivr.net") {
    e.respondWith(savedFirst(req));
  } else if (/\/videos\/[^/]+\.mp4$/.test(url.pathname) && url.searchParams.has("h") && !req.headers.has("range")) {
    e.respondWith(savedVideo(req));
  } else if (/\/videos\/[^/]+\.mp4$/.test(url.pathname) && url.searchParams.has("h")) {
    e.respondWith(savedVideoPart(req));
  } else if (/\/videos\/index\.json$/.test(url.pathname)) {
    e.respondWith(fetch(req).then(async (res) => {
      if (res.ok) (await caches.open(VIDEO)).put(req.url, res.clone());
      return res;
    }).catch(async () => (await caches.match(req.url, { cacheName: VIDEO })) || Response.error()));
  } else if (url.origin === location.origin) {
    e.respondWith(networkFirst(req));
  }
});

async function savedFirst(req) {
  const hit = await caches.match(req);
  if (hit) return hit;
  const res = await fetch(req);
  if (res.ok || res.type === "opaque") (await caches.open(CDN)).put(req, res.clone());
  return res;
}
async function savedVideo(req) {
  const cache = await caches.open(VIDEO);
  const hit = await cache.match(req.url);
  if (hit) return hit;
  const res = await fetch(req);
  if (res.ok && res.status === 200) {
    // keep only this version of the video
    const path = new URL(req.url).pathname;
    for (const old of await cache.keys()) if (new URL(old.url).pathname === path) await cache.delete(old);
    await cache.put(req.url, res.clone());
  }
  return res;
}
// a video element asks for parts of a video (Range): answer from a saved copy if there is one
async function savedVideoPart(req) {
  const hit = await (await caches.open(VIDEO)).match(req.url);
  const m = /^bytes=(\d+)-(\d*)$/.exec(req.headers.get("range") || "");
  if (!hit || !m) return fetch(req);
  const buf = await hit.arrayBuffer(), n = buf.byteLength;
  const start = +m[1], end = Math.min(m[2] ? +m[2] : n - 1, n - 1);
  if (start >= n) return new Response(null, { status: 416, headers: { "Content-Range": `bytes */${n}` } });
  return new Response(buf.slice(start, end + 1), { status: 206, headers: {
    "Content-Type": "video/mp4", "Content-Range": `bytes ${start}-${end}/${n}`,
    "Content-Length": String(end - start + 1), "Accept-Ranges": "bytes" } });
}
async function networkFirst(req) {
  try {
    const res = await fetch(req);
    const path = new URL(req.url).pathname;
    if (res.ok && FILES.some((f) => path.endsWith(f.slice(1)) || (f === "./" && path.endsWith("/"))))
      (await caches.open(SHELL)).put(req, res.clone());
    else if (res.ok && res.status === 200) {
      const saved = await caches.open(SAVED);
      if (await saved.match(req, { ignoreSearch: true })) await saved.put(req, res.clone());
    }
    return res;
  } catch (err) {
    return (await caches.match(req, { ignoreSearch: true })) || (await caches.match("./index.html"));
  }
}
// Android's Share menu posts the PDFs here; keep them, then open the reader to show them
async function receiveShare(req) {
  const form = await req.formData();
  const cache = await caches.open(SHARE);
  let n = 0;
  for (const f of form.getAll("pdf")) {
    if (typeof f === "string") continue;
    await cache.put(`./shared/${Date.now()}-${n++}/${encodeURIComponent(f.name || "shared.pdf")}`, new Response(f));
  }
  return Response.redirect(`./?shared=${n}`, 303);
}
