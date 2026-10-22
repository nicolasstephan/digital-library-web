// Offline app shell: the site's own files, served cache-first and refreshed in the background.
// Library data (GitHub API) is cached separately by js/data.js, per data-repo commit.
// Fetches skip the browser's HTTP cache (GitHub Pages sets max-age=600), so a new version never mixes with old files.
const SHELL = "dl-shell-v11";
const FILES = ["./", "index.html", "css/style.css", "css/hud.css", "js/app.js", "js/data.js", "js/github.js", "js/graph.js", "js/theme.js",
  "manifest.webmanifest", "icons/icon.svg", "icons/icon-180.png", "icons/icon-512.png"];

self.addEventListener("install", (e) => e.waitUntil(caches.open(SHELL).then((c) => c.addAll(FILES.map((f) => new Request(f, { cache: "no-cache" }))))));
self.addEventListener("activate", (e) => e.waitUntil(
  caches.keys().then((keys) => Promise.all(keys.filter((k) => k.startsWith("dl-shell-") && k !== SHELL).map((k) => caches.delete(k))))));

self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET" || url.origin !== location.origin) return; // GitHub API: not handled here
  e.respondWith(caches.open(SHELL).then(async (cache) => {
    const hit = await cache.match(e.request, { ignoreSearch: true });
    const fresh = fetch(e.request.url, { cache: "no-cache" }).then((res) => { if (res.ok) cache.put(e.request, res.clone()); return res; }).catch(() => hit);
    return hit || fresh;
  }));
});
