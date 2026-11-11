/* sw.js — service worker. Cache-first app shell so the board opens with no signal.
 * __BUILD__ is replaced with the git commit at deploy time; a new value = new cache = clean update.
 * Only same-origin GETs are handled. Supabase calls go straight to the network (sync.js deals with failures).
 */
const VERSION = "__BUILD__";
const CACHE = "tonyslist-" + VERSION;

// must all succeed, or the install fails and the old version keeps running
const SHELL = [
  "./", "index.html", "fonts.css", "config.js", "localdb.js", "sync.js",
  "manifest.webmanifest", "icons/icon-192.png", "icons/icon-512.png", "icons/apple-touch-icon.png"
];
// fetched at deploy time by scripts/vendor.mjs: nice to have, never blocks the install
const VENDOR = [
  "vendor/Sortable.min.js",
  "vendor/fonts/bungee-latin-400-normal.woff2",
  "vendor/fonts/barlow-semi-condensed-latin-400-normal.woff2",
  "vendor/fonts/barlow-semi-condensed-latin-500-normal.woff2",
  "vendor/fonts/barlow-semi-condensed-latin-600-normal.woff2",
  "vendor/fonts/barlow-semi-condensed-latin-700-normal.woff2",
  "vendor/fonts/share-tech-mono-latin-400-normal.woff2"
];

self.addEventListener("install", e => {
  e.waitUntil((async () => {
    const c = await caches.open(CACHE);
    await c.addAll(SHELL.map(u => new Request(u, { cache: "reload" })));
    await Promise.all(VENDOR.map(u => c.add(new Request(u, { cache: "reload" })).catch(() => {})));
    await self.skipWaiting();
  })());
});

self.addEventListener("activate", e => {
  e.waitUntil((async () => {
    for (const k of await caches.keys()) if (k.startsWith("tonyslist-") && k !== CACHE) await caches.delete(k);
    await self.clients.claim();
  })());
});

self.addEventListener("fetch", e => {
  const req = e.request, url = new URL(req.url);
  if (req.method !== "GET" || url.origin !== self.location.origin) return;
  e.respondWith((async () => {
    const c = await caches.open(CACHE);
    // page loads (including the Home Screen icon's start URL) always get the cached shell
    const hit = await c.match(req.mode === "navigate" ? "index.html" : req, { ignoreSearch: true });
    if (hit) return hit;
    try {
      const res = await fetch(req);
      if (res.ok) c.put(req, res.clone());      // anything else first-seen online gets cached for next time
      return res;
    } catch (err) {
      return new Response("Offline and not cached yet.", { status: 503, headers: { "Content-Type": "text/plain" } });
    }
  })());
});
