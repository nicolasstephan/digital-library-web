// Offline app shell: the site's own files, network first (so a deploy shows up on the next load), cache when offline.
// Library data (GitHub API) is cached separately by js/data.js, per data-repo commit.
// Fetches skip the browser's HTTP cache (GitHub Pages sets max-age=600), so a new version never mixes with old files.
// A new worker takes over at once (skipWaiting + claim); js/app.js reloads the page when that happens.
const SHELL = "dl-shell-v19";
const FILES = ["./", "index.html", "css/style.css", "css/styles/hud.css", "css/hud.css", "js/app.js", "js/data.js", "js/github.js", "js/graph.js", "js/timeline.js", "js/theme.js",
  "manifest.webmanifest", "icons/icon.svg", "icons/icon-180.png", "icons/icon-512.png",
  // HUD style fonts (self-hosted, shared from the hub's templates/styles), so the style also works offline
  ...["ChakraPetch-500", "ChakraPetch-600", "IBMPlexMono-400", "IBMPlexMono-500", "IBMPlexSans-400", "IBMPlexSans-500", "IBMPlexSans-600"]
    .map((f) => `css/styles/fonts/${f}.woff2`)];

self.addEventListener("install", (e) => e.waitUntil(
  caches.open(SHELL).then((c) => c.addAll(FILES.map((f) => new Request(f, { cache: "no-cache" })))).then(() => self.skipWaiting())));
self.addEventListener("activate", (e) => e.waitUntil(
  caches.keys().then((keys) => Promise.all(keys.filter((k) => k.startsWith("dl-shell-") && k !== SHELL).map((k) => caches.delete(k))))
    .then(() => self.clients.claim())));

self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET" || url.origin !== location.origin) return; // GitHub API: not handled here
  e.respondWith(caches.open(SHELL).then(async (cache) => {
    try {
      const res = await fetch(e.request.url, { cache: "no-cache" });
      if (res.ok) cache.put(e.request, res.clone());
      return res;
    } catch {
      return (await cache.match(e.request, { ignoreSearch: true })) || Response.error(); // offline
    }
  }));
});
