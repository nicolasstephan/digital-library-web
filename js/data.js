// The library data (books.json, meta.json, search.json, highlights/<id>.json, images/) from one of two sources:
//   GitHub: the private data repo, cached per commit in the Cache API, so it works offline afterwards.
//   Local:  a folder next to the site (?data=../data/), for development; no caching.
import { GitHubRepo } from "./github.js";

const CACHE = "dl-data-v1";
const LAST_SHA = "dl.lastSha";

function cacheKey(kind, version, path) {
  return new Request(`https://dl.cache/${kind}/${version}/${path}`);
}

async function cached(kind, version, path, load) {
  if (!("caches" in self)) return load();
  const cache = await caches.open(CACHE);
  const key = cacheKey(kind, version, path);
  const hit = await cache.match(key);
  if (hit) return hit;
  const res = await load();
  await cache.put(key, res.clone());
  return res;
}

/** Drops cached JSON of older commits (images are kept: their names are content ids). */
async function prune(version) {
  if (!("caches" in self)) return;
  const cache = await caches.open(CACHE);
  for (const req of await cache.keys()) {
    const [kind, v] = new URL(req.url).pathname.split("/").slice(1, 3);
    if (kind === "json" && v !== version) await cache.delete(req);
  }
}

class GitHubSource {
  constructor(cfg) {
    this.gh = new GitHubRepo(cfg);
  }
  async version() {
    try {
      const sha = await this.gh.headSha();
      localStorage.setItem(LAST_SHA, sha);
      return { version: sha, offline: false };
    } catch (e) {
      const last = localStorage.getItem(LAST_SHA);
      if (last && !navigator.onLine) return { version: last, offline: true };
      if (last && e instanceof TypeError) return { version: last, offline: true }; // network error
      throw e;
    }
  }
  json(path, version) {
    return cached("json", version, path, () => this.gh.raw(path, version)).then((r) => r.json());
  }
  async image(path, version) {
    const res = await cached("img", "-", path, () => this.gh.raw(`images/${path}`, version));
    return URL.createObjectURL(await res.blob());
  }
}

class LocalSource {
  constructor(base) {
    this.base = base.endsWith("/") ? base : base + "/";
  }
  async version() {
    return { version: "local", offline: false };
  }
  async json(path) {
    const res = await fetch(this.base + path, { cache: "no-store" });
    if (!res.ok) throw new Error(`${path}: ${res.status}`);
    return res.json();
  }
  async image(path) {
    return this.base + "images/" + path;
  }
}

export class Library {
  constructor(source) {
    this.source = source;
    this.highlightCache = new Map();
    this.imageUrls = new Map();
  }

  static fromSettings(settings, params) {
    if (params.get("data")) return new Library(new LocalSource(params.get("data")));
    if (!settings.repo || !settings.token) return null;
    return new Library(new GitHubSource(settings));
  }

  /** Loads the book list; returns { books: [...], offline }. */
  async open() {
    const { version, offline } = await this.source.version();
    this.version = version;
    this.offline = offline;
    const books = await this.source.json("books.json", version);
    this.books = new Map(Object.values(books).map((b) => [b.id, b]));
    // summaries and tags (meta.json); optional, the library works without it
    const meta = await this.source.json("meta.json", version).catch(() => ({}));
    for (const [id, m] of Object.entries(meta)) if (this.books.has(id)) this.books.get(id).meta = m;
    if (!offline) prune(version);
    return { books: [...this.books.values()], offline };
  }

  async highlights(id) {
    if (!this.highlightCache.has(id)) {
      this.highlightCache.set(id, this.source.json(`highlights/${id}.json`, this.version).then((d) => d.annotations));
    }
    return this.highlightCache.get(id);
  }

  search() {
    this.searchRows ??= this.source.json("search.json", this.version);
    return this.searchRows;
  }

  /** Which books cite which (citations.json from tools/citations.py); null if it was never built. */
  citations() {
    this.citationData ??= this.source.json("citations.json", this.version).catch(() => null);
    return this.citationData;
  }

  image(path) {
    if (!this.imageUrls.has(path)) this.imageUrls.set(path, this.source.image(path, this.version));
    return this.imageUrls.get(path);
  }
}
