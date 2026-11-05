// Canvas view: free boards to collect highlights from different books, with own notes, images, groups and arrows
// (like Miro or the Obsidian canvas). One file per canvas in the data repo, canvases/<id>.json, in the JSON Canvas
// format (jsoncanvas.org: nodes text/file/group + edges), so a canvas also opens in Obsidian. Library cards keep
// their source in node.dl (book id, page, quote, own note); their "text" is written out as Markdown for Obsidian.
// Images are downscaled in the browser and stored as canvases/img/<content hash>.<ext>.
// Every change is kept on this device first (localStorage) and written to the repo a few seconds later.
//
// Board: drag the background to pan, wheel / pinch to zoom (trackpad: two fingers pan), shift-drag to select
// several, double-click the background for a note, double-click a card to write on it, drag the dot on a card's
// edge onto another card for an arrow, Delete removes, Ctrl+Z / Ctrl+Y undo / redo, paste or drop images.

const INDEX = "dl.canvases";          // id → { title, updated, sha (last synced blob), dirty, error }
const CURRENT = "dl.canvasCurrent";   // the canvas that "+ Canvas" buttons add to
const DOC = (id) => `dl.canvas.${id}`;
const VIEW = (id) => `dl.canvasView.${id}`; // pan + zoom per canvas, this device only
const PUSH_DELAY = 5000;
const COLORS = [["", "none"], ["1", "red"], ["3", "yellow"], ["4", "green"], ["5", "blue"], ["6", "purple"]]; // JSON Canvas presets
const MAX_IMG = 1600;

const read = (k, d) => { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } };
const write = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); return true; } catch { return false; } };
const nid = () => Math.random().toString(36).slice(2, 10);

// --- Store: local copies + sync with the data repo -------------------------------------------------
export function canvasStore(lib) {
  let idx = read(INDEX, {});
  const timers = {};
  const listeners = new Set();
  const emit = (id) => listeners.forEach((f) => f(id));
  const saveIdx = () => write(INDEX, idx);
  const src = () => lib.source;

  const store = {
    onChange(f) { listeners.add(f); return () => listeners.delete(f); },
    list: () => Object.entries(idx).map(([id, e]) => ({ id, ...e })).sort((a, b) => String(b.updated).localeCompare(String(a.updated))),
    info: (id) => idx[id],
    get: (id) => read(DOC(id), null),
    get current() { const c = localStorage.getItem(CURRENT); return c && idx[c] ? c : store.list()[0]?.id || null; },
    set current(id) { try { localStorage.setItem(CURRENT, id); } catch { /* private mode */ } },

    /** Keeps a changed canvas on this device and writes it to the repo shortly after. */
    put(doc) {
      doc.updated = new Date().toISOString();
      if (!write(DOC(doc.id), doc)) { idx[doc.id] = { ...idx[doc.id], error: "this device's storage is full" }; saveIdx(); emit(doc.id); return; }
      idx[doc.id] = { ...idx[doc.id], title: doc.title, updated: doc.updated, dirty: true, error: null };
      saveIdx();
      store.schedule(doc.id);
      emit(doc.id);
    },
    create(title = "Untitled canvas") {
      const doc = { id: "c" + Date.now().toString(36), title, created: new Date().toISOString(), nodes: [], edges: [] };
      store.put(doc);
      store.current = doc.id;
      return doc;
    },
    async remove(id) {
      const sha = idx[id]?.sha;
      clearTimeout(timers[id]);
      delete idx[id];
      saveIdx();
      localStorage.removeItem(DOC(id));
      localStorage.removeItem(VIEW(id));
      emit(id);
      if (sha) await src().canvasDelete(id, sha);
    },
    schedule(id, ms = PUSH_DELAY) {
      clearTimeout(timers[id]);
      timers[id] = setTimeout(() => store.push(id), ms);
    },
    /** Writes pending images, then the canvas file. */
    async push(id) {
      clearTimeout(timers[id]);
      let doc = store.get(id);
      if (!doc || !idx[id]?.dirty) return;
      idx[id].pushing = true; emit(id);
      try {
        for (const n of doc.nodes) if (n.dl?.data) {
          await src().canvasUpload(n.file.split("/").pop(), dataBytes(n.dl.data));
          const now = store.get(id); // drop the local copy of the image (re-read: the canvas may have changed meanwhile)
          const m = now?.nodes.find((x) => x.id === n.id);
          if (m?.dl) { delete m.dl.data; write(DOC(id), now); }
        }
        doc = store.get(id);
        const sha = await src().canvasPut(id, serialize(doc), idx[id]?.sha, `canvas “${doc.title}”: ${doc.nodes.length} cards (website)`);
        if (!idx[id]) return; // deleted meanwhile
        idx[id] = { ...idx[id], sha, dirty: store.get(id)?.updated !== doc.updated, error: null, pushing: false };
        if (idx[id].dirty) store.schedule(id);
      } catch (e) {
        if (!idx[id]) return;
        idx[id] = { ...idx[id], pushing: false, error: e.status === 403 || e.status === 404 ? "the token is read-only (Settings: Contents: Read and write)"
          : e.status === "local" ? "local data folder" : navigator.onLine ? e.message : "offline" };
        if (navigator.onLine && e.status !== "local" && e.status !== 403) store.schedule(id, 60000); // try again later
      }
      saveIdx();
      emit(id);
    },
    flush() { for (const id of Object.keys(idx)) if (idx[id].dirty) store.push(id); },
    /** Takes canvases changed elsewhere (other devices); unsynced local changes win and are written back. */
    async sync() {
      const remote = await src().canvasList();
      const shas = new Map(remote.filter((f) => f.name.endsWith(".json")).map((f) => [f.name.slice(0, -5), f.sha]));
      const changed = [];
      for (const [id, sha] of shas) {
        if (idx[id]?.sha === sha || idx[id]?.dirty) continue;
        const f = await src().canvasGet(id);
        if (!f) continue;
        const doc = { ...f.data, id };
        write(DOC(id), doc);
        idx[id] = { title: doc.title, updated: doc.updated, sha: f.sha, dirty: false };
        changed.push(id);
      }
      for (const id of Object.keys(idx)) { // deleted on another device
        if (idx[id].sha && !idx[id].dirty && !shas.has(id)) { delete idx[id]; localStorage.removeItem(DOC(id)); changed.push(id); }
        else if (idx[id].dirty) store.schedule(id, 800);
      }
      saveIdx();
      changed.forEach(emit);
      return changed;
    },
    /** Adds a card to the current canvas (from a "+ Canvas" button elsewhere): to the right of what's there, one below the other. */
    add(node) {
      const doc = store.get(store.current) || store.create("Collected");
      const real = doc.nodes.filter((n) => n.x !== doc.drop?.x); // everything but the column collected so far
      const right = real.length ? Math.max(...real.map((n) => n.x + n.width)) : 0;
      const top = real.length ? Math.min(...real.map((n) => n.y)) : 0;
      if (!doc.drop || doc.drop.x < right) doc.drop = { x: right + 80, y: top };
      Object.assign(node, { x: doc.drop.x, y: doc.drop.y });
      doc.drop.y += node.height + 24;
      doc.nodes.push(node);
      store.put(doc);
      return doc;
    },
  };
  addEventListener("pagehide", () => store.flush());
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "hidden") store.flush(); });
  return store;
}

/** The file as written to the repo: JSON Canvas, with Markdown text for the library cards (for Obsidian). */
function serialize(doc) {
  const nodes = doc.nodes.map((n) => {
    const { dl, ...rest } = n;
    const out = { ...rest, x: Math.round(n.x), y: Math.round(n.y), width: Math.round(n.width), height: Math.round(n.height) };
    if (dl) {
      const { data, ...keep } = dl;
      out.dl = keep;
      if (dl.kind === "quote") out.text = [dl.quote && `> ${dl.quote.replace(/\n/g, "\n> ")}`, dl.comment,
        `— ${dl.title}${dl.by ? `, ${dl.by}` : ""}${dl.page ? `, p. ${dl.page}` : ""}`, dl.note].filter(Boolean).join("\n\n");
      if (dl.kind === "book") out.text = [`**${dl.title}**`, dl.by, dl.note].filter(Boolean).join("\n\n");
      if (dl.kind === "image" && dl.note) out.dl.note = dl.note;
    }
    return out;
  });
  const edges = doc.edges.map((e) => ({ ...e }));
  return { title: doc.title, created: doc.created, updated: doc.updated, nodes, edges };
}

function dataBytes(url) {
  const bin = atob(url.slice(url.indexOf(",") + 1));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

/** A card for one highlight or note (from highlights/<id>.json or a search.json row). */
export function quoteNode(b, a, byline, marks) {
  const type = a.type ?? a.t, text = a.text ?? a.x;
  const mark = marks.has(type);
  return { id: nid(), type: "text", x: 0, y: 0, width: 300, height: mark ? 220 : Math.min(360, 90 + Math.ceil((text || "").length / 38) * 22), text: "",
    dl: { kind: "quote", book: b.id, title: b.title, by: byline(b), page: a.page ?? a.p, quote: mark ? "" : text || "",
      comment: a.comment ?? a.m ?? "", color: a.color ?? a.c ?? "", type, image: a.image ?? a.i ?? "", rect: a.rect } };
}
function bookNode(b, byline) {
  return { id: nid(), type: "text", x: 0, y: 0, width: 280, height: 150, text: "", dl: { kind: "book", book: b.id, title: b.title, by: byline(b) } };
}

/** Downscales an image file and names it by its content: { name, bytes, url, w, h }. */
async function prepareImage(file) {
  const bmp = await createImageBitmap(file);
  const s = Math.min(1, MAX_IMG / Math.max(bmp.width, bmp.height));
  const w = Math.round(bmp.width * s), h = Math.round(bmp.height * s);
  const cv = Object.assign(document.createElement("canvas"), { width: w, height: h });
  cv.getContext("2d").drawImage(bmp, 0, 0, w, h);
  let blob = await new Promise((r) => cv.toBlob(r, "image/webp", 0.85));
  if (!blob || blob.type !== "image/webp") blob = await new Promise((r) => cv.toBlob(r, "image/jpeg", 0.85)); // Safari can't write webp
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const hash = [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))].slice(0, 8).map((x) => x.toString(16).padStart(2, "0")).join("");
  const url = await new Promise((r) => { const fr = new FileReader(); fr.onload = () => r(fr.result); fr.readAsDataURL(blob); });
  return { name: `${hash}.${blob.type === "image/webp" ? "webp" : "jpg"}`, bytes, url, w, h };
}

/** Small Markdown: headings, lists, quotes, **bold**, *italic*, `code`, links, [[Book title]]. */
function markdown(src, esc, bookLink) {
  const inline = (s) => esc(s)
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*]+)\*\*/g, "<b>$1</b>")
    .replace(/(^|[^*\w])\*([^*\s][^*]*?)\*/g, "$1<i>$2</i>")
    .replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1" target="_blank" rel="noopener">$1</a>')
    .replace(/\[\[([^\]]+)\]\]/g, (m, t) => bookLink(t));
  let html = "", list = false;
  for (const line of String(src || "").split("\n")) {
    if (/^\s*[-*] /.test(line)) { if (!list) { html += "<ul>"; list = true; } html += `<li>${inline(line.replace(/^\s*[-*] /, ""))}</li>`; continue; }
    if (list) { html += "</ul>"; list = false; }
    if (/^#{1,3} /.test(line)) html += `<h4>${inline(line.replace(/^#+ /, ""))}</h4>`;
    else if (/^> ?/.test(line)) html += `<blockquote>${inline(line.replace(/^> ?/, ""))}</blockquote>`;
    else if (line.trim()) html += `<p>${inline(line)}</p>`;
  }
  return html + (list ? "</ul>" : "");
}

// --- View -------------------------------------------------------------------------------------------
export function viewCanvas(main, ctx) {
  const { books, lib, esc, fold, byline, isMine, store, marks, setStatus } = ctx;
  main.classList.add("wide");
  const byId = new Map(books.map((b) => [b.id, b]));
  let doc = null, view = { x: 40, y: 40, z: 1 };
  const sel = new Set();
  let selEdge = null, editing = null, undo = [], redo = [];

  main.innerHTML = `
    <div class="toolbar cv-bar">
      <select id="cvpick" aria-label="Canvas"></select>
      <input id="cvtitle" class="cv-title" aria-label="Canvas name" autocomplete="off">
      <button type="button" class="ghost" id="cvnote" title="New note (or double-click the board)">+ Note</button>
      <button type="button" class="ghost" id="cvgroup" title="New group: cards inside move with it">+ Group</button>
      <label class="ghost btn" title="Add images (or paste / drop them on the board)">+ Image<input type="file" id="cvfile" accept="image/*" multiple hidden></label>
      <button type="button" id="cvlib" aria-pressed="true" title="Highlights and books to drag onto the board">Library</button>
      <span class="cv-sync" id="cvsync"></span>
      <button type="button" class="ghost cv-del" id="cvdel">Delete canvas</button>
    </div>
    <div class="cv-wrap" id="cvwrap">
      <div class="cv-board" id="cvboard" tabindex="0">
        <div class="cv-stage" id="cvstage"><div id="cvgroups"></div><svg class="cv-edges" id="cvedges"></svg><div id="cvnodes"></div><div id="cvlabels"></div></div>
        <div class="cv-marquee" id="cvmarq" hidden></div>
        <div class="cv-selbar" id="cvselbar" hidden></div>
        <div class="cv-zoom"><button type="button" data-z="-" title="Zoom out">−</button><button type="button" data-z="1" id="cvz" title="Actual size">100%</button><button type="button" data-z="+" title="Zoom in">+</button><button type="button" data-z="fit" title="Show everything">Fit</button></div>
        <p class="cv-hint" id="cvhint"></p>
      </div>
      <aside class="cv-side" id="cvside">
        <input id="cvq" type="search" placeholder="Search highlights, notes, books" autocomplete="off">
        <label class="check"><input type="checkbox" id="cvmine" checked> only mine</label>
        <div class="cv-results" id="cvres"></div>
      </aside>
    </div>`;
  const $ = (s) => main.querySelector(s);
  const board = $("#cvboard"), stage = $("#cvstage"), groupsEl = $("#cvgroups"), nodesEl = $("#cvnodes"), edgesEl = $("#cvedges"),
    labelsEl = $("#cvlabels"), marq = $("#cvmarq"), selbar = $("#cvselbar"), side = $("#cvside"), wrap = $("#cvwrap");
  const els = new Map();

  // --- canvas picker, title, sync state
  const fillPicker = () => {
    const list = store.list();
    $("#cvpick").innerHTML = list.map((c) => `<option value="${esc(c.id)}" ${doc?.id === c.id ? "selected" : ""}>${esc(c.title || "Untitled")}</option>`).join("") +
      `<option value="__new">+ New canvas…</option>`;
  };
  const showSync = () => {
    const i = doc && store.info(doc.id);
    const el = $("#cvsync");
    el.textContent = !i ? "" : i.error ? `On this device only: ${i.error}` : i.pushing ? "Saving…" : i.dirty ? "Changed" : i.sha ? "Saved" : "";
    el.dataset.kind = i?.error ? "warn" : "";
  };
  const open = (id) => {
    if (editing) endEdit();
    doc = (id && store.get(id)) || null;
    if (!doc) doc = store.list().length ? store.get(store.list()[0].id) : store.create("First canvas");
    store.current = doc.id;
    view = read(VIEW(doc.id), null) || { x: 40, y: 40, z: 1 };
    sel.clear(); selEdge = null; undo = []; redo = [];
    els.forEach((el) => el.remove()); els.clear();
    $("#cvtitle").value = doc.title || "";
    fillPicker(); showSync(); applyView(); draw();
    if (!read(VIEW(doc.id), null) && doc.nodes.length) fitAll();
  };

  // --- model changes (undo snapshots)
  const snap = () => JSON.stringify({ nodes: doc.nodes, edges: doc.edges });
  const commit = (before) => {
    if (before === snap()) return;
    undo.push(before); if (undo.length > 80) undo.shift();
    redo = [];
    store.put(doc);
  };
  const change = (fn) => { const before = snap(); fn(); commit(before); draw(); };
  const restore = (from, to) => {
    if (!from.length) return;
    to.push(snap());
    Object.assign(doc, JSON.parse(from.pop()));
    sel.clear(); selEdge = null;
    store.put(doc); draw();
  };

  // --- view transform
  const applyView = () => {
    stage.style.transform = `translate(${view.x}px, ${view.y}px) scale(${view.z})`;
    $("#cvz").textContent = `${Math.round(view.z * 100)}%`;
    clearTimeout(applyView.t);
    applyView.t = setTimeout(() => doc && write(VIEW(doc.id), view), 300);
  };
  const toWorld = (cx, cy) => { const r = board.getBoundingClientRect(); return { x: (cx - r.left - view.x) / view.z, y: (cy - r.top - view.y) / view.z }; };
  const zoomAt = (cx, cy, z) => {
    z = Math.min(3, Math.max(0.1, z));
    const r = board.getBoundingClientRect(), w = toWorld(cx, cy);
    view = { x: cx - r.left - w.x * z, y: cy - r.top - w.y * z, z };
    applyView();
  };
  const center = () => { const r = board.getBoundingClientRect(); return toWorld(r.left + r.width / 2, r.top + r.height / 2); };
  const fitAll = () => {
    const ns = doc.nodes;
    const r = board.getBoundingClientRect();
    if (!ns.length) { view = { x: 40, y: 40, z: 1 }; applyView(); return; }
    const x0 = Math.min(...ns.map((n) => n.x)), y0 = Math.min(...ns.map((n) => n.y));
    const x1 = Math.max(...ns.map((n) => n.x + n.width)), y1 = Math.max(...ns.map((n) => n.y + n.height));
    const z = Math.min(1.5, Math.max(0.1, Math.min((r.width - 80) / (x1 - x0 || 1), (r.height - 80) / (y1 - y0 || 1))));
    view = { x: (r.width - (x1 - x0) * z) / 2 - x0 * z, y: (r.height - (y1 - y0) * z) / 2 - y0 * z, z };
    applyView();
  };

  // --- drawing
  const bookLink = (t) => {
    const f = fold(t.replace(/&amp;/g, "&"));
    const b = books.find((x) => fold(x.title) === f) || books.find((x) => fold(x.title).startsWith(f));
    return b ? `<a href="#/book/${b.id}">${t}</a>` : `<span class="cv-wl">${t}</span>`;
  };
  const plain = (n) => n.type === "text" && !n.dl?.kind; // a note of its own (not a library card)
  const noteOf = (n) => plain(n) ? n.text || "" : n.dl?.note || "";
  const setNote = (n, t) => { if (plain(n)) n.text = t; else { n.dl = { ...n.dl, note: t }; if (!t) delete n.dl.note; } };
  const body = (n) => {
    const d = n.dl || {}, note = noteOf(n);
    const own = note ? `<div class="cv-text">${markdown(note, esc, bookLink)}</div>` : "";
    if (n.type === "group") return `<div class="cv-glabel">${esc(n.label || "Group")}</div>`;
    if (n.type === "file") return `<img class="cv-img" data-cimg="${esc(n.file.split("/").pop())}" alt="" draggable="false">${own}`;
    if (d.kind === "quote") {
      const b = byId.get(d.book);
      return `${d.image ? `<img data-aimg="${esc(d.image)}" alt="" draggable="false">` : ""}
        ${d.quote ? `<blockquote>${esc(d.quote)}</blockquote>` : ""}
        ${d.comment ? `<p class="comment">${esc(d.comment)}</p>` : ""}${own}
        <footer><a href="#/book/${esc(d.book)}">${esc(b?.title || d.title)}</a>${d.page ? ` · p. ${esc(d.page)}` : ""}</footer>`;
    }
    if (d.kind === "book") {
      const b = byId.get(d.book);
      return `<h3><a href="#/book/${esc(d.book)}">${esc(b?.title || d.title)}</a></h3><p class="meta">${esc(b ? byline(b) : d.by)}</p>
        ${b?.meta?.summary && !note ? `<p class="cv-sum">${esc(b.meta.summary)}</p>` : ""}${own}`;
    }
    return own || `<p class="cv-ph">Double-click to write</p>`;
  };
  const kindOf = (n) => n.type === "group" ? "group" : n.type === "file" ? "image" : n.dl?.kind || "note";
  const loadImgs = (el, n) => {
    el.querySelectorAll("img").forEach(async (img) => {
      img.addEventListener("load", () => autoHeight(n), { once: true });
      try {
        img.src = img.dataset.cimg ? (n.dl?.data || await lib.canvasImage(img.dataset.cimg)) : await lib.image(img.dataset.aimg);
      } catch { img.replaceWith(Object.assign(document.createElement("p"), { className: "muted", textContent: "image not available" })); }
    });
  };
  const draw = () => {
    if (!doc) return;
    const ids = new Set(doc.nodes.map((n) => n.id));
    for (const [id, el] of els) if (!ids.has(id)) { el.remove(); els.delete(id); }
    for (const n of doc.nodes) {
      let el = els.get(n.id);
      const parent = n.type === "group" ? groupsEl : nodesEl;
      if (!el || el.parentNode !== parent) { el?.remove(); el = document.createElement("div"); el.dataset.id = n.id; parent.appendChild(el); els.set(n.id, el); }
      const sig = JSON.stringify([n.type, n.text, n.label, n.file, n.dl]);
      if (el._sig !== sig && editing?.id !== n.id) {
        el._sig = sig;
        el.className = `cv-node k-${kindOf(n)}`;
        el.innerHTML = `<div class="cv-body">${body(n)}</div>${n.type === "group" ? "" : `<span class="cv-port" title="Drag onto another card to connect"></span>`}<span class="cv-handle" title="Resize"></span>`;
        if (n.dl?.color) el.style.setProperty("--hl", n.dl.color);
        loadImgs(el, n);
      }
      el.dataset.color = n.color || "";
      el.classList.toggle("sel", sel.has(n.id));
      place(el, n);
    }
    drawEdges();
    selBar();
    $("#cvhint").hidden = doc.nodes.length > 0;
    $("#cvhint").innerHTML = `Empty canvas. Drag highlights from the Library panel, <b>double-click</b> for a note, paste or drop images.`;
  };
  const place = (el, n) => {
    el.style.transform = `translate(${n.x}px, ${n.y}px)`;
    el.style.width = `${n.width}px`;
    el.style.height = `${n.height}px`;
  };
  /** Grows (or, if never resized by hand, fits) a card to its content. */
  const autoHeight = (n) => {
    const el = els.get(n.id);
    if (!el || n.type === "group") return;
    el.style.height = "auto";
    const h = Math.min(n.type === "text" && !n.dl?.kind ? 640 : 380, Math.max(60, Math.ceil(el.offsetHeight))); // long quotes scroll inside
    const nh = n.dl?.sized ? Math.max(n.height, h) : h;
    el.style.height = `${n.height}px`;
    if (Math.abs(nh - n.height) > 1) { n.height = nh; place(el, n); drawEdges(); write(DOC(doc.id), doc); }
  };

  const anchor = (n, side) => side === "left" ? [n.x, n.y + n.height / 2] : side === "right" ? [n.x + n.width, n.y + n.height / 2]
    : side === "top" ? [n.x + n.width / 2, n.y] : [n.x + n.width / 2, n.y + n.height];
  const NORMAL = { left: [-1, 0], right: [1, 0], top: [0, -1], bottom: [0, 1] };
  const sides = (a, b) => {
    const dx = (b.x + b.width / 2) - (a.x + a.width / 2), dy = (b.y + b.height / 2) - (a.y + a.height / 2);
    return Math.abs(dx) / (a.width + b.width) > Math.abs(dy) / (a.height + b.height)
      ? (dx > 0 ? ["right", "left"] : ["left", "right"]) : (dy > 0 ? ["bottom", "top"] : ["top", "bottom"]);
  };
  const curve = (p, sp, q, sq) => {
    const k = Math.max(40, Math.hypot(q[0] - p[0], q[1] - p[1]) / 3);
    const c1 = [p[0] + NORMAL[sp][0] * k, p[1] + NORMAL[sp][1] * k];
    const c2 = sq ? [q[0] + NORMAL[sq][0] * k, q[1] + NORMAL[sq][1] * k] : q;
    const mid = [0, 1].map((i) => 0.125 * p[i] + 0.375 * c1[i] + 0.375 * c2[i] + 0.125 * q[i]);
    return { d: `M${p[0]},${p[1]} C${c1[0]},${c1[1]} ${c2[0]},${c2[1]} ${q[0]},${q[1]}`, mid };
  };
  let temp = null; // the arrow being drawn: { from, to: [x, y] }
  const drawEdges = () => {
    const m = new Map(doc.nodes.map((n) => [n.id, n]));
    let svg = `<defs><marker id="cvarrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="8" markerHeight="8" orient="auto-start-reverse">
      <path d="M0,1 L10,5 L0,9 z" class="cv-arrow"/></marker></defs>`, labels = "";
    for (const e of doc.edges) {
      const a = m.get(e.fromNode), b = m.get(e.toNode);
      if (!a || !b) continue;
      const [sa, sb] = sides(a, b);
      e.fromSide = sa; e.toSide = sb;
      const { d, mid } = curve(anchor(a, sa), sa, anchor(b, sb), sb);
      svg += `<g data-edge="${esc(e.id)}" class="${selEdge === e.id ? "sel" : ""}"><path class="cv-hit" d="${d}"/><path class="cv-line" d="${d}" marker-end="url(#cvarrow)"/></g>`;
      if (e.label) labels += `<span class="cv-elabel${selEdge === e.id ? " sel" : ""}" data-edge="${esc(e.id)}" style="transform: translate(${mid[0]}px, ${mid[1]}px) translate(-50%, -50%)">${esc(e.label)}</span>`;
    }
    if (temp) {
      const a = m.get(temp.from), side = Math.abs(temp.to[0] - (a.x + a.width / 2)) / a.width > Math.abs(temp.to[1] - (a.y + a.height / 2)) / a.height
        ? (temp.to[0] > a.x + a.width / 2 ? "right" : "left") : (temp.to[1] > a.y + a.height / 2 ? "bottom" : "top");
      svg += `<path class="cv-line temp" d="${curve(anchor(a, side), side, temp.to, null).d}" marker-end="url(#cvarrow)"/>`;
    }
    edgesEl.innerHTML = svg;
    labelsEl.innerHTML = labels;
  };

  // --- selection bar: color, open the book, delete
  const selBar = () => {
    const ns = doc.nodes.filter((n) => sel.has(n.id));
    if (!ns.length && !selEdge) { selbar.hidden = true; return; }
    selbar.hidden = false;
    const one = ns.length === 1 ? ns[0] : null;
    selbar.innerHTML = (ns.length ? COLORS.map(([c, name]) =>
      `<button type="button" class="cv-sw" data-color="${c}" title="${name}" aria-pressed="${ns.every((n) => (n.color || "") === c)}"></button>`).join("") : "") +
      (one?.dl?.book ? `<a class="btn" href="#/book/${esc(one.dl.book)}">Book page</a>` : "") +
      (selEdge ? `<button type="button" data-act="label">Label</button>` : "") +
      `<button type="button" data-act="del" title="Delete (Del)">Delete</button>`;
  };
  selbar.addEventListener("pointerdown", (e) => e.stopPropagation());
  selbar.addEventListener("click", (e) => {
    const c = e.target.closest("[data-color]");
    if (c) change(() => doc.nodes.forEach((n) => { if (sel.has(n.id)) { if (c.dataset.color) n.color = c.dataset.color; else delete n.color; } }));
    const act = e.target.closest("[data-act]")?.dataset.act;
    if (act === "del") del();
    if (act === "label") editLabel(selEdge);
  });
  const del = () => change(() => {
    doc.nodes = doc.nodes.filter((n) => !sel.has(n.id));
    doc.edges = doc.edges.filter((e) => e.id !== selEdge && !sel.has(e.fromNode) && !sel.has(e.toNode));
    sel.clear(); selEdge = null;
  });

  // --- editing text (notes, own note on a library card, group label, arrow label)
  const startEdit = (n) => {
    if (editing) endEdit();
    const el = els.get(n.id);
    if (!el) return;
    editing = { id: n.id, before: snap() };
    const group = n.type === "group";
    const ta = document.createElement(group ? "input" : "textarea");
    ta.className = "cv-edit";
    ta.value = group ? n.label || "" : noteOf(n);
    ta.placeholder = group ? "Group name" : n.dl ? "Your note on this…" : "Write… (Markdown: # heading, - list, **bold**, [[Book title]])";
    if (group) el.querySelector(".cv-glabel").replaceChildren(ta);
    else { el.querySelector(".cv-body").append(ta); el.classList.add("editing"); }
    const grow = () => { if (!group) { ta.style.height = "auto"; ta.style.height = `${ta.scrollHeight + 2}px`; } };
    ta.addEventListener("input", grow);
    ta.addEventListener("keydown", (e) => {
      if (e.key === "Escape" || (e.key === "Enter" && (e.ctrlKey || e.metaKey || group))) { e.preventDefault(); endEdit(); board.focus(); }
      e.stopPropagation();
    });
    ta.addEventListener("blur", () => setTimeout(() => editing?.id === n.id && endEdit(), 0));
    ta.addEventListener("pointerdown", (e) => e.stopPropagation());
    ta.focus(); grow();
    if (group) ta.select(); else ta.setSelectionRange(ta.value.length, ta.value.length);
    autoHeight(n);
  };
  const endEdit = () => {
    if (!editing) return;
    const { id, before } = editing;
    const n = doc.nodes.find((x) => x.id === id), el = els.get(id);
    const ta = el?.querySelector(".cv-edit");
    editing = null;
    if (n && ta) {
      if (n.type === "group") n.label = ta.value.trim() || "Group";
      else setNote(n, ta.value.replace(/\s+$/, ""));
      if (plain(n) && !n.text) { doc.nodes = doc.nodes.filter((x) => x !== n); doc.edges = doc.edges.filter((x) => x.fromNode !== id && x.toNode !== id); sel.delete(id); } // an empty note goes away
    }
    if (el) { el._sig = null; el.classList.remove("editing"); }
    draw();
    if (n) autoHeight(n);
    commit(before);
  };
  const editLabel = (edgeId) => {
    const e = doc.edges.find((x) => x.id === edgeId);
    if (!e) return;
    const m = new Map(doc.nodes.map((n) => [n.id, n]));
    const a = m.get(e.fromNode), b = m.get(e.toNode);
    const { mid } = curve(anchor(a, e.fromSide), e.fromSide, anchor(b, e.toSide), e.toSide);
    const inp = Object.assign(document.createElement("input"), { className: "cv-edit cv-elabel-edit", value: e.label || "", placeholder: "Label" });
    inp.style.transform = `translate(${mid[0]}px, ${mid[1]}px) translate(-50%, -50%)`;
    labelsEl.append(inp);
    const before = snap();
    let done = false;
    const finish = () => { if (done) return; done = true; e.label = inp.value.trim(); if (!e.label) delete e.label; inp.remove(); commit(before); draw(); };
    inp.addEventListener("keydown", (ev) => { ev.stopPropagation(); if (ev.key === "Enter" || ev.key === "Escape") { ev.preventDefault(); finish(); board.focus(); } });
    inp.addEventListener("blur", finish);
    inp.addEventListener("pointerdown", (ev) => ev.stopPropagation());
    inp.focus();
  };

  // --- adding cards
  const addNodes = (nodes, at) => {
    if (!nodes.length) return;
    const p = at || center();
    let y = p.y;
    change(() => {
      for (const n of nodes) { n.x = Math.round(p.x - n.width / 2); n.y = Math.round(y); y += n.height + 20; doc.nodes.push(n); }
      sel.clear(); nodes.forEach((n) => sel.add(n.id)); selEdge = null;
    });
    nodes.forEach((n) => autoHeight(n));
  };
  const addNote = (at) => {
    const n = { id: nid(), type: "text", x: 0, y: 0, width: 240, height: 90, text: "" };
    addNodes([n], at);
    startEdit(n);
  };
  const addImages = async (files, at) => {
    const nodes = [];
    for (const f of files) {
      if (!f.type.startsWith("image/")) continue;
      try {
        setStatus(`Preparing ${f.name || "image"}…`);
        const img = await prepareImage(f);
        const w = Math.min(360, img.w);
        const n = { id: nid(), type: "file", file: `canvases/img/${img.name}`, x: 0, y: 0, width: w, height: Math.round(w * img.h / img.w), dl: { kind: "image", sized: true, data: img.url } };
        nodes.push(n);
        lib.source.canvasUpload(img.name, img.bytes).then(() => { // uploaded: the local copy isn't needed
          const m = doc?.nodes.find((x) => x.id === n.id) || store.get(store.current)?.nodes.find((x) => x.id === n.id);
          if (m?.dl?.data) { delete m.dl.data; if (doc) write(DOC(doc.id), doc); }
        }).catch(() => { /* stays on this device; the next save of the canvas tries again */ });
      } catch (e) { setStatus(`Image not added: ${e.message}`, "warn"); }
    }
    if (nodes.length) { addNodes(nodes, at); setStatus(`${nodes.length} image${nodes.length > 1 ? "s" : ""} added`); }
  };

  // --- pointer: select, move, resize, connect, pan, marquee, pinch
  const pts = new Map();
  let g = null; // current gesture
  const inside = (n, grp) => n !== grp && n.x + n.width / 2 > grp.x && n.x + n.width / 2 < grp.x + grp.width &&
    n.y + n.height / 2 > grp.y && n.y + n.height / 2 < grp.y + grp.height; // its center lies in the group
  board.addEventListener("pointerdown", (e) => {
    if (e.button > 1) return;
    pts.set(e.pointerId, [e.clientX, e.clientY]);
    if (pts.size === 2) { // pinch: zoom + pan with two fingers
      const [a, b] = [...pts.values()];
      g = { kind: "pinch", d0: Math.hypot(a[0] - b[0], a[1] - b[1]), c0: [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2], v0: { ...view } };
      return;
    }
    if (e.target.closest(".cv-zoom, .cv-selbar, .cv-edit, a")) return;
    if (editing) endEdit();
    board.focus({ preventScroll: true });
    const w = toWorld(e.clientX, e.clientY);
    const nodeEl = e.target.closest(".cv-node"), n = nodeEl && doc.nodes.find((x) => x.id === nodeEl.dataset.id);
    const edgeEl = e.target.closest("[data-edge]");
    board.setPointerCapture(e.pointerId);
    if (e.button === 1) { g = { kind: "pan", sx: e.clientX, sy: e.clientY, v0: { ...view }, moved: true }; return; }
    if (n && e.target.closest(".cv-port")) { g = { kind: "link", from: n.id }; temp = { from: n.id, to: [w.x, w.y] }; return; }
    if (n && e.target.closest(".cv-handle")) { g = { kind: "resize", n, w0: n.width, h0: n.height, s: w, before: snap() }; return; }
    if (edgeEl && !n) { // select the arrow without redrawing it (a redraw would lose a following double-click)
      selEdge = edgeEl.dataset.edge; sel.clear();
      els.forEach((el) => el.classList.remove("sel"));
      main.querySelectorAll("[data-edge]").forEach((x) => x.classList.toggle("sel", x.dataset.edge === selEdge));
      selBar(); g = null; return;
    }
    if (n) {
      if (e.shiftKey || e.ctrlKey || e.metaKey) { sel.has(n.id) ? sel.delete(n.id) : sel.add(n.id); }
      else if (!sel.has(n.id)) { sel.clear(); sel.add(n.id); }
      selEdge = null;
      // moving: the selected cards, plus whatever sits inside a selected group
      const moving = new Set(doc.nodes.filter((x) => sel.has(x.id)));
      for (const grp of [...moving].filter((x) => x.type === "group")) for (const x of doc.nodes) if (inside(x, grp)) moving.add(x);
      g = { kind: "move", s: w, items: [...moving].map((x) => [x, x.x, x.y]), before: snap(), moved: false };
      draw();
      return;
    }
    if (e.shiftKey) { g = { kind: "marquee", s: w, base: new Set(sel) }; return; }
    g = { kind: "pan", sx: e.clientX, sy: e.clientY, v0: { ...view }, moved: false };
  });
  board.addEventListener("pointermove", (e) => {
    if (pts.has(e.pointerId)) pts.set(e.pointerId, [e.clientX, e.clientY]);
    if (!g) return;
    if (g.kind === "pinch") {
      if (pts.size < 2) return;
      const [a, b] = [...pts.values()], c = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
      const z = Math.min(3, Math.max(0.1, g.v0.z * Math.hypot(a[0] - b[0], a[1] - b[1]) / (g.d0 || 1)));
      const r = board.getBoundingClientRect();
      const wx = (g.c0[0] - r.left - g.v0.x) / g.v0.z, wy = (g.c0[1] - r.top - g.v0.y) / g.v0.z;
      view = { x: c[0] - r.left - wx * z, y: c[1] - r.top - wy * z, z };
      applyView();
      return;
    }
    const w = toWorld(e.clientX, e.clientY);
    if (g.kind === "pan") {
      if (Math.abs(e.clientX - g.sx) + Math.abs(e.clientY - g.sy) > 3) g.moved = true;
      view = { ...view, x: g.v0.x + e.clientX - g.sx, y: g.v0.y + e.clientY - g.sy };
      applyView();
    } else if (g.kind === "move") {
      const dx = w.x - g.s.x, dy = w.y - g.s.y;
      if (!g.moved && Math.abs(dx) + Math.abs(dy) < 3 / view.z) return;
      g.moved = true;
      for (const [n, x, y] of g.items) { n.x = Math.round(x + dx); n.y = Math.round(y + dy); place(els.get(n.id), n); }
      drawEdges();
    } else if (g.kind === "resize") {
      const n = g.n;
      n.width = Math.max(n.type === "group" ? 160 : 120, Math.round(g.w0 + w.x - g.s.x));
      n.height = Math.max(n.type === "group" ? 100 : 50, Math.round(g.h0 + w.y - g.s.y));
      place(els.get(n.id), n);
      drawEdges();
    } else if (g.kind === "link") {
      temp.to = [w.x, w.y];
      drawEdges();
    } else if (g.kind === "marquee") {
      const x0 = Math.min(g.s.x, w.x), y0 = Math.min(g.s.y, w.y), x1 = Math.max(g.s.x, w.x), y1 = Math.max(g.s.y, w.y);
      Object.assign(marq.style, { left: `${x0 * view.z + view.x}px`, top: `${y0 * view.z + view.y}px`, width: `${(x1 - x0) * view.z}px`, height: `${(y1 - y0) * view.z}px` });
      marq.hidden = false;
      sel.clear(); g.base.forEach((id) => sel.add(id));
      for (const n of doc.nodes) if (n.x < x1 && n.x + n.width > x0 && n.y < y1 && n.y + n.height > y0) sel.add(n.id);
      els.forEach((el, id) => el.classList.toggle("sel", sel.has(id)));
    }
  });
  const up = (e) => {
    pts.delete(e.pointerId);
    if (!g) return;
    if (g.kind === "pinch") { if (pts.size === 0) g = null; return; }
    if (g.kind === "pan" && !g.moved) { sel.clear(); selEdge = null; draw(); }
    if (g.kind === "move" && g.moved) { commit(g.before); draw(); }
    if (g.kind === "resize") { if (g.n.type !== "group") g.n.dl = { ...g.n.dl, sized: true }; commit(g.before); draw(); }
    if (g.kind === "link") {
      temp = null;
      const target = document.elementFromPoint(e.clientX, e.clientY)?.closest(".cv-node");
      const to = target?.dataset.id;
      if (to && to !== g.from && !doc.edges.some((x) => x.fromNode === g.from && x.toNode === to)) {
        change(() => doc.edges.push({ id: nid(), fromNode: g.from, toNode: to, toEnd: "arrow" }));
      } else drawEdges();
    }
    if (g.kind === "marquee") { marq.hidden = true; selBar(); }
    g = null;
  };
  board.addEventListener("pointerup", up);
  board.addEventListener("pointercancel", up);
  board.addEventListener("dblclick", (e) => {
    // pointer capture sends the double-click to the board: look at what is really under the pointer
    const t = document.elementFromPoint(e.clientX, e.clientY) || e.target;
    if (t.closest(".cv-zoom, .cv-selbar, .cv-edit, a")) return;
    const nodeEl = t.closest(".cv-node"), n = nodeEl && doc.nodes.find((x) => x.id === nodeEl.dataset.id);
    if (n && (n.type !== "group" || t.closest(".cv-glabel"))) { startEdit(n); return; }
    const edgeEl = t.closest("[data-edge]");
    if (edgeEl) { editLabel(edgeEl.dataset.edge); return; }
    const w = toWorld(e.clientX, e.clientY);
    addNote({ x: w.x + 120, y: w.y });
  });
  // wheel: a mouse wheel zooms, a trackpad pans (pinch on a trackpad comes as ctrl+wheel and zooms)
  board.addEventListener("wheel", (e) => {
    if (e.target.closest(".cv-edit")) return;
    const scroller = e.target.closest(".cv-node.sel .cv-body");
    if (scroller && scroller.scrollHeight > scroller.clientHeight && !e.ctrlKey) return; // scroll inside a selected card
    e.preventDefault();
    const mouse = e.deltaMode === 1 || (e.deltaX === 0 && Math.abs(e.deltaY) >= 50 && !e.ctrlKey);
    if (e.ctrlKey || mouse) zoomAt(e.clientX, e.clientY, view.z * Math.exp(-e.deltaY * (e.deltaMode === 1 ? 0.05 : e.ctrlKey ? 0.01 : 0.0015)));
    else { view = { ...view, x: view.x - e.deltaX, y: view.y - e.deltaY }; applyView(); }
  }, { passive: false });
  main.querySelector(".cv-zoom").addEventListener("click", (e) => {
    const z = e.target.closest("[data-z]")?.dataset.z;
    const r = board.getBoundingClientRect(), cx = r.left + r.width / 2, cy = r.top + r.height / 2;
    if (z === "+") zoomAt(cx, cy, view.z * 1.25);
    if (z === "-") zoomAt(cx, cy, view.z / 1.25);
    if (z === "1") zoomAt(cx, cy, 1);
    if (z === "fit") fitAll();
  });

  // --- keyboard, paste, drop
  const onKey = (e) => {
    if (!doc || e.target.closest?.("input, textarea, select, [contenteditable]")) return;
    const mod = e.ctrlKey || e.metaKey;
    if ((e.key === "Delete" || e.key === "Backspace") && (sel.size || selEdge)) { e.preventDefault(); del(); }
    else if (mod && e.key.toLowerCase() === "z" && !e.shiftKey) { e.preventDefault(); restore(undo, redo); }
    else if (mod && (e.key.toLowerCase() === "y" || (e.key.toLowerCase() === "z" && e.shiftKey))) { e.preventDefault(); restore(redo, undo); }
    else if (mod && e.key.toLowerCase() === "a") { e.preventDefault(); doc.nodes.forEach((n) => sel.add(n.id)); draw(); }
    else if (e.key === "Escape") { sel.clear(); selEdge = null; draw(); }
    else if (e.key === "Enter" && sel.size === 1) { e.preventDefault(); startEdit(doc.nodes.find((n) => sel.has(n.id))); }
  };
  document.addEventListener("keydown", onKey);
  const onPaste = (e) => {
    if (!doc || e.target.closest?.("input, textarea, [contenteditable]")) return;
    const files = [...(e.clipboardData?.files || [])].filter((f) => f.type.startsWith("image/"));
    if (files.length) { e.preventDefault(); addImages(files); return; }
    const text = e.clipboardData?.getData("text/plain");
    if (text?.trim()) {
      e.preventDefault();
      const n = { id: nid(), type: "text", x: 0, y: 0, width: 280, height: 90, text: text.trim() };
      addNodes([n]);
    }
  };
  document.addEventListener("paste", onPaste);
  board.addEventListener("dragover", (e) => { e.preventDefault(); e.dataTransfer.dropEffect = "copy"; });
  board.addEventListener("drop", (e) => {
    e.preventDefault();
    const at = toWorld(e.clientX, e.clientY);
    const key = e.dataTransfer.getData("text/x-dl-card");
    if (key && dragItems.has(key)) { addNodes([dragItems.get(key)()], at); return; }
    if (e.dataTransfer.files.length) addImages([...e.dataTransfer.files], at);
  });

  // --- toolbar
  $("#cvpick").addEventListener("change", (e) => {
    if (e.target.value === "__new") { store.flush(); open(store.create().id); $("#cvtitle").select(); $("#cvtitle").focus(); }
    else { store.flush(); open(e.target.value); }
  });
  $("#cvtitle").addEventListener("change", (e) => { doc.title = e.target.value.trim() || "Untitled canvas"; store.put(doc); fillPicker(); });
  $("#cvtitle").addEventListener("keydown", (e) => { if (e.key === "Enter") e.target.blur(); });
  $("#cvnote").addEventListener("click", () => addNote());
  $("#cvgroup").addEventListener("click", () => {
    // a group around the selected cards, else an empty one in the middle
    const ns = doc.nodes.filter((n) => sel.has(n.id));
    const grp = { id: nid(), type: "group", label: "Group", x: 0, y: 0, width: 480, height: 320 };
    if (ns.length) {
      const x0 = Math.min(...ns.map((n) => n.x)), y0 = Math.min(...ns.map((n) => n.y));
      Object.assign(grp, { x: x0 - 30, y: y0 - 60, width: Math.max(...ns.map((n) => n.x + n.width)) - x0 + 60, height: Math.max(...ns.map((n) => n.y + n.height)) - y0 + 90 });
      change(() => { doc.nodes.unshift(grp); sel.clear(); sel.add(grp.id); });
    } else {
      const c = center();
      Object.assign(grp, { x: Math.round(c.x - 240), y: Math.round(c.y - 160) });
      change(() => { doc.nodes.unshift(grp); sel.clear(); sel.add(grp.id); });
    }
    startEdit(grp);
  });
  $("#cvfile").addEventListener("change", (e) => { addImages([...e.target.files]); e.target.value = ""; });
  const sideOn = read("dl.canvasSide", true);
  wrap.classList.toggle("noside", !sideOn);
  $("#cvlib").setAttribute("aria-pressed", sideOn);
  $("#cvlib").addEventListener("click", (e) => {
    const on = wrap.classList.toggle("noside") === false;
    e.target.setAttribute("aria-pressed", on);
    write("dl.canvasSide", on);
    if (on) $("#cvq").focus();
  });
  let delArmed = null;
  $("#cvdel").addEventListener("click", async (e) => {
    if (!delArmed) { // second click within 3 s deletes
      e.target.textContent = `Delete “${doc.title}”?`;
      e.target.classList.add("armed");
      delArmed = setTimeout(() => { delArmed = null; e.target.textContent = "Delete canvas"; e.target.classList.remove("armed"); }, 3000);
      return;
    }
    clearTimeout(delArmed); delArmed = null;
    e.target.textContent = "Delete canvas"; e.target.classList.remove("armed");
    const title = doc.title, id = doc.id;
    doc = null;
    try { await store.remove(id); setStatus(`Canvas “${title}” deleted`); } catch (err) { setStatus(`Canvas deleted here; not in the repo: ${err.message}`, "warn"); }
    open(store.list()[0]?.id);
  });

  // --- library panel: search highlights and books, open a book's notes; drag items onto the board or click +
  const dragItems = new Map();
  let dk = 0;
  const item = (make, html, cls = "") => { const k = `k${++dk}`; dragItems.set(k, make); return `<div class="cv-item ${cls}" draggable="true" data-k="${k}">${html}<button type="button" class="cv-add" data-k="${k}" title="Add to the canvas">+</button></div>`; };
  const quoteHtml = (b, a) => {
    const text = a.text ?? a.x, comment = a.comment ?? a.m, type = a.type ?? a.t, image = a.image ?? a.i;
    return `<div class="cv-q" style="--hl:${esc(a.color ?? a.c ?? "var(--muted)")}">
      ${text && !marks.has(type) ? `<blockquote>${esc(text.length > 280 ? text.slice(0, 280) + "…" : text)}</blockquote>` : image ? `<p class="muted">handwriting / mark${text ? `: ${esc(text.slice(0, 80))}` : ""}</p>` : ""}
      ${comment ? `<p class="comment">${esc(comment)}</p>` : ""}
      <p class="meta">${b ? esc(b.title.length > 60 ? b.title.slice(0, 60) + "…" : b.title) + " · " : ""}p. ${esc(a.page ?? a.p)}</p></div>`;
  };
  let rows = null, openBook = null, lastAdded = null;
  const mineOnly = () => $("#cvmine").checked;
  const results = async () => {
    dragItems.clear();
    const res = $("#cvres"), q = $("#cvq").value;
    if (openBook) {
      const b = openBook;
      res.innerHTML = `<button type="button" class="cv-back" id="cvback">← Back</button>
        ${item(() => bookNode(b, byline), `<div class="cv-b"><b>${esc(b.title)}</b><span class="meta">${esc(byline(b))}</span><span class="muted">book card</span></div>`, "book")}
        <div id="cvbooknotes"><p class="muted">Loading…</p></div>`;
      const box = res.querySelector("#cvbooknotes");
      if (!b.annotations) { box.innerHTML = `<p class="muted">${b.read ? "No highlights or notes in this book." : "Not read yet (only in iCloud)."}</p>`; return; }
      let items;
      try { items = await lib.highlights(b.id); } catch (e) { box.innerHTML = `<p class="error">${esc(e.message)}</p>`; return; }
      if (openBook !== b) return;
      const list = items.filter((a) => !mineOnly() || isMine(a));
      box.innerHTML = list.map((a) => item(() => quoteNode(b, a, byline, marks), quoteHtml(null, a))).join("") || `<p class="muted">Only notes by others.</p>`;
      return;
    }
    const words = fold(q).split(/\s+/).filter(Boolean);
    if (!words.length) {
      if (!books.some((b) => b.lastAnnotated)) { await lib.search().catch(() => null); await null; } // app.js fills lastAnnotated from it
      // nothing typed: books already on this canvas, then the most recently annotated
      const onCanvas = [...new Set(doc.nodes.map((n) => n.dl?.book).filter(Boolean))].map((id) => byId.get(id)).filter(Boolean);
      const recent = books.filter((b) => b.lastAnnotated && !onCanvas.includes(b)).sort((a, b) => b.lastAnnotated.localeCompare(a.lastAnnotated)).slice(0, 12);
      res.innerHTML = `<p class="hint">Search, or open a book to pick its highlights. Drag them onto the board or click +.</p>` +
        (onCanvas.length ? `<h4>On this canvas</h4>${onCanvas.map(bookRow).join("")}` : "") +
        (recent.length ? `<h4>Recently annotated</h4>${recent.map(bookRow).join("")}` : "");
      return;
    }
    const bs = books.filter((b) => words.every((w) => fold(`${b.title} ${(b.names || b.authors || []).join(" ")} ${b.year || ""}`).includes(w))).slice(0, 8);
    res.innerHTML = `${bs.length ? `<h4>Books</h4>${bs.map(bookRow).join("")}` : ""}<h4>Highlights and notes</h4><div id="cvhits"><p class="muted">Searching…</p></div>`;
    try { rows ??= await lib.search(); } catch (e) { res.querySelector("#cvhits").innerHTML = `<p class="error">${esc(e.message)}</p>`; return; }
    if ($("#cvq").value !== q) return;
    const hits = rows.filter((r) => (!mineOnly() || isMine({ author: r.a })) && words.every((w) => fold(`${r.x || ""} ${r.m || ""}`).includes(w)));
    res.querySelector("#cvhits").innerHTML = hits.slice(0, 60).map((r) => {
      const b = byId.get(r.b);
      return b ? item(() => quoteNode(b, r, byline, marks), quoteHtml(b, r)) : "";
    }).join("") + (hits.length > 60 ? `<p class="muted">${hits.length - 60} more; refine the search.</p>` : hits.length ? "" : `<p class="muted">No matches.</p>`);
  };
  const bookRow = (b) => `<button type="button" class="cv-bookrow" data-book="${esc(b.id)}"><b>${esc(b.title)}</b><span class="meta">${esc(byline(b))}${b.annotations ? ` · ${b.annotations} notes` : ""}</span></button>`;
  let qt;
  $("#cvq").addEventListener("input", () => { openBook = null; clearTimeout(qt); qt = setTimeout(results, 150); });
  $("#cvmine").addEventListener("change", results);
  side.addEventListener("click", (e) => {
    const add = e.target.closest(".cv-add");
    if (add && dragItems.has(add.dataset.k)) {
      // below the card added last, while that is still in view; else in the middle of the view
      const n = dragItems.get(add.dataset.k)();
      const last = doc.nodes.find((x) => x.id === lastAdded);
      const r = board.getBoundingClientRect(), tl = toWorld(r.left, r.top), br = toWorld(r.right, r.bottom);
      const c = center();
      const seen = last && last.x < br.x && last.x + last.width > tl.x && last.y < br.y && last.y + last.height > tl.y;
      const at = !seen ? { x: c.x, y: c.y - 120 }
        : last.y + last.height + 20 < br.y - 80 ? { x: last.x + last.width / 2, y: last.y + last.height + 20 } // below the last one
        : { x: last.x + last.width + 20 + n.width / 2, y: Math.max(tl.y + 30, Math.min(...doc.nodes.filter((x) => x.id === lastAdded || x.x === last.x).map((x) => x.y))) }; // next column
      addNodes([n], at);
      lastAdded = n.id;
      return;
    }
    const row = e.target.closest(".cv-bookrow");
    if (row) { openBook = byId.get(row.dataset.book); results(); side.scrollTop = 0; return; }
    if (e.target.closest("#cvback")) { openBook = null; results(); }
  });
  side.addEventListener("dragstart", (e) => {
    const it = e.target.closest(".cv-item");
    if (!it) return;
    e.dataTransfer.setData("text/x-dl-card", it.dataset.k);
    e.dataTransfer.effectAllowed = "copy";
  });

  // --- sync with the repo; other views (+ Canvas buttons) and other devices
  const off = store.onChange((id) => {
    if (!doc || id !== doc.id) { fillPicker(); return; }
    showSync();
    const fresh = store.get(id);
    if (!fresh) { open(null); return; }
    if (fresh.updated !== doc.updated && !g && !editing) { doc = fresh; draw(); } // changed outside this view
  });
  main.dispose = () => {
    if (editing) endEdit();
    off();
    document.removeEventListener("keydown", onKey);
    document.removeEventListener("paste", onPaste);
    store.flush();
  };

  open(store.current);
  results();
  store.sync().then((changed) => { if (doc && changed.includes(doc.id)) open(doc.id); else fillPicker(); })
    .catch((e) => { if (e.status !== "local") setStatus(`Canvases not synced: ${e.message}`, "warn"); });
}
