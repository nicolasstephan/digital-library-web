// Digital Library website: library list, book view with highlights, search across all highlights, graph, settings.
// Routes (hash): #/  ·  #/book/<id>  ·  #/search?q=…  ·  #/graph  ·  #/settings
import { Library } from "./data.js";
import { viewGraph } from "./graph.js";
import { getThemeMode, setThemeMode } from "./theme.js";

const SETTINGS = "dl.settings";
const VIEW = "dl.view"; // remembered list filters (per device)
const DEFAULT_MINE = ["nicolas", "nicolas stephan", "nicol", 'iPad Pro 11" 4', "..."];
const COLLECTIONS = { Authors: "Authors", Collections: "Collections", Proceedings: "Proceedings", Add: "Add", "00_Inbox": "Inbox" };
const MARKS = new Set(["Ink", "Square", "Circle", "Line", "Polygon", "PolyLine"]);

const $ = (sel, el = document) => el.querySelector(sel);
const main = $("#main");
const params = new URLSearchParams(location.search);

function load(key, fallback) {
  try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch { return fallback; }
}
function save(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* private mode: session only */ }
}
function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}
function fold(s) {
  return String(s ?? "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
}
function terms(q) {
  return fold(q).split(/\s+/).filter(Boolean);
}
/** Escapes text and wraps every occurrence of the search terms in <mark>. */
function marked(text, words) {
  if (!words.length || !text) return esc(text);
  const f = fold(text);
  const hits = [];
  for (const w of words) for (let i = f.indexOf(w); i >= 0; i = f.indexOf(w, i + w.length)) hits.push([i, i + w.length]);
  hits.sort((a, b) => a[0] - b[0]);
  let out = "", pos = 0;
  for (const [a, b] of hits) {
    if (a < pos) continue;
    out += esc(text.slice(pos, a)) + "<mark>" + esc(text.slice(a, b)) + "</mark>";
    pos = b;
  }
  return out + esc(text.slice(pos));
}
function byline(b) {
  const a = (b.authors || []).join(", ");
  return [a, b.year].filter(Boolean).join(" · ");
}
function kindLabel(t) {
  return { Highlight: "highlight", Underline: "underline", StrikeOut: "strike-out", Squiggly: "squiggly", Ink: "handwriting",
    Square: "box", Circle: "circle", Line: "line", Text: "note", FreeText: "text box" }[t] || t.toLowerCase();
}

let settings = load(SETTINGS, {});
const mine = () => new Set((settings.mine || DEFAULT_MINE).map((s) => s.toLowerCase()));
const isMine = (a) => !a.author || mine().has(a.author.toLowerCase());
let lib = Library.fromSettings(settings, params);
let books = [];
let status = "";

function setStatus(text, kind = "") {
  status = text;
  const el = $("#status");
  el.textContent = text;
  el.dataset.kind = kind;
}

// --- Library list -------------------------------------------------------------------------------
function viewLibrary() {
  const v = load(VIEW, { q: "", show: "annotated", coll: "", sort: "author" });
  main.innerHTML = `
    <div class="toolbar">
      <input id="filter" type="search" placeholder="Filter by title or author" value="${esc(v.q)}" autocomplete="off">
      <div class="seg" role="group" aria-label="Show">
        ${[["all", "All"], ["annotated", "Annotated"], ["unread", "Not read yet"]].map(([k, l]) =>
          `<button data-show="${k}" aria-pressed="${v.show === k}">${l}</button>`).join("")}
      </div>
      <select id="coll" aria-label="Collection">
        <option value="">All collections</option>
        ${Object.entries(COLLECTIONS).map(([k, l]) => `<option value="${k}" ${v.coll === k ? "selected" : ""}>${l}</option>`).join("")}
      </select>
      <select id="sort" aria-label="Sort">
        ${[["author", "Author"], ["title", "Title"], ["year", "Year"], ["most", "Most annotated"], ["recent", "Recently annotated"]]
          .map(([k, l]) => `<option value="${k}" ${v.sort === k ? "selected" : ""}>${l}</option>`).join("")}
      </select>
    </div>
    <p class="count" id="count"></p>
    <ul class="books" id="list"></ul>`;

  const render = () => {
    save(VIEW, v);
    const words = terms(v.q);
    let list = books.filter((b) => {
      if (v.show === "annotated" && !b.annotations) return false;
      if (v.show === "unread" && b.read) return false;
      if (v.coll && b.collection !== v.coll) return false;
      if (!words.length) return true;
      const hay = fold(`${b.title} ${(b.authors || []).join(" ")} ${b.year || ""}`);
      return words.every((w) => hay.includes(w));
    });
    const key = (b) => fold((b.authors || [])[0] || b.title);
    const sorters = {
      author: (a, b) => key(a).localeCompare(key(b)) || (a.year || 0) - (b.year || 0),
      title: (a, b) => fold(a.title).localeCompare(fold(b.title)),
      year: (a, b) => (b.year || 0) - (a.year || 0),
      most: (a, b) => (b.annotations || 0) - (a.annotations || 0),
      recent: (a, b) => String(b.lastAnnotated || "").localeCompare(String(a.lastAnnotated || "")),
    };
    list.sort(sorters[v.sort]);
    $("#count").textContent = `${list.length} of ${books.length} books`;
    $("#list").innerHTML = list.map((b) => `
      <li><a href="#/book/${b.id}" class="book ${b.read ? "" : "unread"}">
        <span class="title">${marked(b.title, words)}</span>
        <span class="meta">${marked(byline(b), words)}${b.collection !== "Authors" ? ` <span class="tag">${esc(COLLECTIONS[b.collection] || b.collection)}</span>` : ""}</span>
        <span class="n" title="annotations">${b.annotations ? b.annotations : b.read ? "" : "not read"}</span>
      </a></li>`).join("") || `<li class="empty">No books match.</li>`;
  };

  $("#filter").addEventListener("input", (e) => { v.q = e.target.value; render(); });
  main.querySelectorAll("[data-show]").forEach((btn) => btn.addEventListener("click", () => {
    v.show = btn.dataset.show;
    main.querySelectorAll("[data-show]").forEach((b) => b.setAttribute("aria-pressed", b === btn));
    render();
  }));
  $("#coll").addEventListener("change", (e) => { v.coll = e.target.value; render(); });
  $("#sort").addEventListener("change", (e) => { v.sort = e.target.value; render(); });
  render();
}

// --- One book ------------------------------------------------------------------------------------
function annotationHtml(a, words = []) {
  const color = a.color || a.c || "var(--muted)";
  const text = a.text ?? a.x;
  const comment = a.comment ?? a.m;
  const type = a.type || a.t;
  const image = a.image ?? a.i;
  const author = a.author ?? a.a;
  const foreign = author && !mine().has(author.toLowerCase());
  return `
    <article class="note ${MARKS.has(type) ? "mark" : ""}" style="--hl:${esc(color)}">
      ${text && !MARKS.has(type) ? `<blockquote>${marked(text, words)}</blockquote>` : ""}
      ${image ? `<img data-img="${esc(image)}" alt="${esc(kindLabel(type))} on page ${a.page ?? a.p}">` : ""}
      ${comment ? `<p class="comment">${marked(comment, words)}</p>` : ""}
      ${text && MARKS.has(type) ? `<details><summary>text under the mark</summary><p class="under">${marked(text, words)}</p></details>` : ""}
      <footer>${esc(kindLabel(type))}${foreign ? ` · by ${esc(author)}` : ""}</footer>
    </article>`;
}

function loadImages(root) {
  root.querySelectorAll("img[data-img]").forEach(async (img) => {
    try { img.src = await lib.image(img.dataset.img); } catch { img.replaceWith(Object.assign(document.createElement("p"), { className: "muted", textContent: "image not available offline" })); }
  });
}

async function viewBook(id) {
  const b = lib && books.find((x) => x.id === id);
  if (!b) { main.innerHTML = `<p class="empty">Book not found. <a href="#/">Back to the library</a></p>`; return; }
  const opts = load("dl.bookView", { mineOnly: true, hl: true, marks: true, notes: true });
  main.innerHTML = `
    <a href="#/" class="back">← Library</a>
    <header class="bookhead">
      <h1>${esc(b.title)}</h1>
      <p class="meta">${esc(byline(b))}${b.pages ? ` · ${b.pages} pages` : ""}</p>
      <p class="path">${esc(b.path)}${b.copies ? ` <span class="muted">(+${b.copies.length} identical ${b.copies.length === 1 ? "copy" : "copies"})</span>` : ""}</p>
    </header>
    <div id="body"><p class="muted">Loading…</p></div>`;
  if (!b.read) {
    $("#body").innerHTML = `<p class="empty">Not read yet: this file is only in iCloud. It gets read once it is downloaded on the laptop or PC (open it there once), or with a full extractor run.</p>`;
    return;
  }
  if (!b.annotations) { $("#body").innerHTML = `<p class="empty">No highlights or notes in this book yet.</p>`; return; }

  let items;
  try { items = await lib.highlights(id); } catch (e) { $("#body").innerHTML = `<p class="error">${esc(e.message)}</p>`; return; }
  const foreign = items.filter((a) => !isMine(a)).length;
  const render = () => {
    save("dl.bookView", opts);
    const shown = items.filter((a) =>
      (!opts.mineOnly || isMine(a)) &&
      (MARKS.has(a.type) ? opts.marks : ["Text", "FreeText"].includes(a.type) ? opts.notes : opts.hl));
    let page = null, html = "";
    for (const a of shown) {
      if (a.page !== page) { html += `${page !== null ? "</section>" : ""}<section class="page"><h2>p. ${a.page}</h2>`; page = a.page; }
      html += annotationHtml(a);
    }
    if (page !== null) html += "</section>";
    $("#notes").innerHTML = html || `<p class="empty">Nothing to show with these filters.</p>`;
    loadImages($("#notes"));
  };
  const count = (f) => items.filter(f).length;
  $("#body").innerHTML = `
    <div class="toolbar">
      <div class="seg" role="group" aria-label="Show">
        <button data-opt="hl" aria-pressed="${opts.hl}">Highlights ${count((a) => !MARKS.has(a.type) && !["Text", "FreeText"].includes(a.type))}</button>
        <button data-opt="marks" aria-pressed="${opts.marks}">Handwriting &amp; marks ${count((a) => MARKS.has(a.type))}</button>
        <button data-opt="notes" aria-pressed="${opts.notes}">Notes ${count((a) => ["Text", "FreeText"].includes(a.type))}</button>
      </div>
      ${foreign ? `<label class="check"><input type="checkbox" id="mine" ${opts.mineOnly ? "checked" : ""}> only mine <span class="muted">(${foreign} by others)</span></label>` : ""}
    </div>
    <div id="notes"></div>`;
  $("#body").querySelectorAll("[data-opt]").forEach((btn) => btn.addEventListener("click", () => {
    opts[btn.dataset.opt] = !opts[btn.dataset.opt];
    btn.setAttribute("aria-pressed", opts[btn.dataset.opt]);
    render();
  }));
  $("#mine")?.addEventListener("change", (e) => { opts.mineOnly = e.target.checked; render(); });
  render();
}

// --- Search across all highlights ----------------------------------------------------------------
async function viewSearch(q) {
  main.innerHTML = `
    <div class="toolbar"><input id="q" type="search" placeholder="Search all highlights and notes" value="${esc(q)}" autocomplete="off" autofocus></div>
    <p class="count" id="count"></p>
    <div id="results"></div>`;
  let rows;
  try { rows = await lib.search(); } catch (e) { $("#results").innerHTML = `<p class="error">${esc(e.message)}</p>`; return; }
  const titles = new Map(books.map((b) => [b.id, b]));
  const render = (q) => {
    history.replaceState(null, "", `#/search?q=${encodeURIComponent(q)}`);
    const words = terms(q);
    if (!words.length) { $("#count").textContent = `${rows.length} highlights and notes in ${new Set(rows.map((r) => r.b)).size} books`; $("#results").innerHTML = ""; return; }
    const hits = rows.filter((r) => { const hay = fold(`${r.x || ""} ${r.m || ""}`); return words.every((w) => hay.includes(w)); });
    const groups = new Map();
    for (const r of hits) (groups.get(r.b) || groups.set(r.b, []).get(r.b)).push(r);
    $("#count").textContent = `${hits.length} matches in ${groups.size} books`;
    $("#results").innerHTML = [...groups].slice(0, 60).map(([bid, rs]) => {
      const b = titles.get(bid) || { title: "?", authors: [] };
      return `<section class="hitbook">
        <h2><a href="#/book/${bid}">${esc(b.title)}</a> <span class="meta">${esc(byline(b))}</span></h2>
        ${rs.slice(0, 20).map((r) => `<div class="hit"><span class="pg">p. ${r.p}</span>${annotationHtml(r, words)}</div>`).join("")}
      </section>`;
    }).join("") + (groups.size > 60 ? `<p class="muted">Showing the first 60 books; refine the search.</p>` : "");
    loadImages($("#results"));
  };
  let t;
  $("#q").addEventListener("input", (e) => { clearTimeout(t); t = setTimeout(() => render(e.target.value), 150); });
  render(q);
}

/** Library list filtered to one author (from the graph). */
function openAuthor(name) {
  save(VIEW, { ...load(VIEW, { sort: "author" }), q: name, show: "all", coll: "" });
  location.hash = "#/";
}

// --- Settings ------------------------------------------------------------------------------------
function viewSettings(first = false) {
  main.innerHTML = `
    <form class="settings" id="form">
      <h1>${first ? "Connect your library" : "Settings"}</h1>
      ${first ? `<p>The highlights live in your private GitHub repo. Connect it once on each device; the token stays on this device.</p>` : ""}
      <label>Data repo<input name="repo" value="${esc(settings.repo || "nicolasstephan/digital-library-data")}" required></label>
      <label>GitHub token<input name="token" type="password" value="${esc(settings.token || "")}" placeholder="github_pat_…" required autocomplete="off"></label>
      <p class="hint">Create a <a href="https://github.com/settings/personal-access-tokens/new" target="_blank" rel="noopener">fine-grained token</a>: repository access <b>only digital-library-data</b>, permission <b>Contents: Read</b> (later Read and write, for notes).</p>
      <label>Appearance<select id="theme">${["system", "light", "dark"].map((m) =>
        `<option value="${m}"${getThemeMode() === m ? " selected" : ""}>${m[0].toUpperCase() + m.slice(1)}</option>`).join("")}</select></label>
      <label>My annotations are signed as <span class="muted">(one name per line; others count as “by others”)</span>
        <textarea name="mine" rows="5">${esc((settings.mine || DEFAULT_MINE).join("\n"))}</textarea></label>
      <div class="row"><button type="submit" class="primary">Save and load</button>
        ${!first ? `<button type="button" id="clear" class="ghost">Clear offline data</button>` : ""}</div>
      <p id="msg" class="hint"></p>
    </form>`;
  $("#theme").addEventListener("change", (e) => setThemeMode(e.target.value));
  $("#form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const f = new FormData(e.target);
    settings = { repo: f.get("repo").trim(), token: f.get("token").trim(),
      mine: f.get("mine").split("\n").map((s) => s.trim()).filter(Boolean) };
    save(SETTINGS, settings);
    lib = Library.fromSettings(settings, params);
    $("#msg").textContent = "Loading…";
    if (await start()) location.hash = "#/";
    else $("#msg").textContent = status;
  });
  $("#clear")?.addEventListener("click", async () => {
    await caches.delete("dl-data-v1");
    localStorage.removeItem("dl.lastSha");
    $("#msg").textContent = "Offline data cleared; it loads again on the next start.";
  });
}

// --- Start and routing ---------------------------------------------------------------------------
async function start() {
  if (!lib) return false;
  setStatus("loading…");
  try {
    const r = await lib.open();
    books = r.books;
    // newest annotation per book, for "Recently annotated"
    const read = books.filter((b) => b.read).length;
    setStatus(r.offline ? `offline · ${books.length} books` : `${books.length} books · ${read} read`, r.offline ? "warn" : "");
    lib.search().then((rows) => {
      const last = new Map();
      for (const x of rows) if (x.d && (!last.get(x.b) || x.d > last.get(x.b))) last.set(x.b, x.d);
      for (const b of books) b.lastAnnotated = last.get(b.id) || null;
    }).catch(() => {});
    return true;
  } catch (e) {
    setStatus(e.message, "error");
    return false;
  }
}

function route() {
  const [path, query] = location.hash.slice(1).split("?");
  document.querySelectorAll("nav a").forEach((a) => a.classList.toggle("active", a.getAttribute("href") === "#" + (path || "/")));
  main.dispose?.();
  main.dispose = null;
  main.classList.remove("wide");
  if (!lib) return viewSettings(true);
  if (path?.startsWith("/book/")) return viewBook(path.slice(6));
  if (path === "/search") return viewSearch(new URLSearchParams(query).get("q") || "");
  if (path === "/graph") return viewGraph(main, { books, lib, esc, fold, load, save, openAuthor });
  if (path === "/settings") return viewSettings();
  viewLibrary();
  window.scrollTo(0, 0);
}

window.addEventListener("hashchange", route);
if ("serviceWorker" in navigator && location.protocol === "https:") navigator.serviceWorker.register("sw.js");
(async () => {
  if (lib && !(await start())) { viewSettings(); $("#msg").textContent = status; return; }
  route();
})();
