// PDF viewer pane (PDF.js, vendored in vendor/pdfjs): shows a book's PDF, jumps to a page and frames an annotation,
// selects and copies text, finds text, and highlights: a selection gets a small menu (colors, note, copy), and the
// highlight is written into the PDF itself by the local PDF server (pdfserver.py), so PDF Expert / Acrobat and the
// extractor see it like any other. A maximize button lifts the viewer above the whole page.
// The PDFs are not in the data repo. A PDF comes from the browser's own store (Cache API "dl-pdf-v1", kept per
// device after the first time), else from the local PDF server on the laptop/PC (127.0.0.1:8767, reads the iCloud
// library), else the person picks the file (iPhone/iPad: Files > iCloud Drive > Library).

const STORE = "dl-pdf-v1";
const SERVER = "http://127.0.0.1:8767";
const PDFJS = new URL("../vendor/pdfjs/", import.meta.url).href;
// highlight colors (annotation data, like the ones PDF Expert writes)
const COLORS = [["Yellow", "#ffd84d"], ["Green", "#86d97a"], ["Blue", "#76b7ff"], ["Pink", "#ff8fb4"]];

let pdfjs = null;
async function lib() {
  if (!pdfjs) {
    pdfjs = await import(PDFJS + "pdf.min.js");
    pdfjs.GlobalWorkerOptions.workerSrc = PDFJS + "pdf.worker.min.js";
  }
  return pdfjs;
}

const key = (id) => new Request(new URL(`pdf-store/${id}.pdf`, location.href));
async function stored(id) {
  try { return await (await caches.open(STORE)).match(key(id)); } catch { return null; }
}
async function keep(id, blob) {
  try { await (await caches.open(STORE)).put(key(id), new Response(blob, { headers: { "Content-Type": "application/pdf" } })); } catch { /* no storage: works this session only */ }
}
async function forget(id) {
  try { await (await caches.open(STORE)).delete(key(id)); } catch { /* nothing kept */ }
}
let up = null; // is the PDF server reachable (checked once per open)
async function serverUp() {
  try { up = (await fetch(`${SERVER}/ping`, { signal: AbortSignal.timeout(800) })).ok; } catch { up = false; }
  return up;
}
async function download(b) {
  const r = await fetch(`${SERVER}/pdf?path=${encodeURIComponent(b.path)}`);
  if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `server said ${r.status}`);
  return r.blob();
}
const mb = (n) => `${(n / 1048576).toFixed(n < 10485760 ? 1 : 0)} MB`;
const rgb = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);

/** A viewer in `el`. show(book, page, rect) opens the book (or offers the download) at that page. */
export function pdfViewer(el, { esc, onHighlight }) {
  let doc = null, book = null, pages = [], scale = 1, zoom = 1, observer = null, target = null, token = 0;
  let find = { q: "", hits: [], i: -1 }, texts = new Map();
  const home = { parent: el.parentNode, next: el.nextSibling };
  const $ = (s) => el.querySelector(s);

  const empty = (msg) => {
    token++;
    observer?.disconnect();
    doc?.destroy();
    doc = null; book = null; pages = [];
    el.innerHTML = `<div class="pv-bar"><span class="pv-title muted">PDF</span>${maxBtn()}</div><div class="pv-body"><p class="muted pv-msg">${msg}</p></div>`;
  };
  const maxBtn = () => `<button class="pv-btn" data-act="max" title="${el.classList.contains("max") ? "Back to the side (Esc)" : "Maximize"}" aria-label="Maximize">${el.classList.contains("max") ? "⤡" : "⤢"}</button>`;

  const shell = (b) => `
    <div class="pv-bar">
      <span class="pv-title" title="${esc(b.title)}">${esc(b.title)}</span>
      <span class="pv-tools" id="pvtools" hidden>
        <button class="pv-btn" data-act="prev" title="Previous page" aria-label="Previous page">‹</button>
        <span class="pv-page"><input id="pvn" inputmode="numeric" aria-label="Page"> / <span id="pvof"></span></span>
        <button class="pv-btn" data-act="next" title="Next page" aria-label="Next page">›</button>
        <button class="pv-btn" data-z="-1" title="Smaller" aria-label="Smaller">−</button>
        <button class="pv-btn" data-act="fit" title="Fit width" aria-label="Fit width">↔</button>
        <button class="pv-btn" data-z="1" title="Larger" aria-label="Larger">+</button>
        <button class="pv-btn" data-act="find" title="Find in the book" aria-label="Find">⌕</button>
      </span>
      ${maxBtn()}
    </div>
    <div class="pv-find" id="pvfind" hidden>
      <input id="pvq" type="search" placeholder="Find in this book" autocomplete="off">
      <span id="pvhits" class="muted"></span>
      <button class="pv-btn" data-act="hitprev" title="Previous match" aria-label="Previous match">↑</button>
      <button class="pv-btn" data-act="hitnext" title="Next match" aria-label="Next match">↓</button>
    </div>
    <div class="pv-body" id="pvbody"></div>
    <div class="pv-menu" id="pvmenu" hidden>
      ${COLORS.map(([n, c]) => `<button class="pv-dot" data-color="${c}" style="background:${c}" title="Highlight ${n.toLowerCase()}" aria-label="Highlight ${n}"></button>`).join("")}
      <button class="pv-mbtn" data-act="note">Note…</button>
      <button class="pv-mbtn" data-act="copy">Copy</button>
    </div>`;

  // --- getting the PDF -----------------------------------------------------------------------------
  const ask = async (b, page, rect, my) => {
    const body = $("#pvbody");
    body.innerHTML = `<p class="muted pv-msg">Checking for the PDF…</p>`;
    await serverUp();
    if (my !== token) return;
    const where = esc(String(b.path).replace(/\\/g, " › "));
    body.innerHTML = `<div class="pv-get">
      <p>This PDF is not on this device yet${b.size ? ` (${mb(b.size)})` : ""}.</p>
      ${up ? `<button class="primary" id="pvdl">Download PDF</button>
              <p class="hint">from the iCloud library on this computer</p>` : ""}
      <label class="${up ? "pv-alt" : "pv-pick"}">${up ? "or choose the file…" : "Choose PDF…"}
        <input type="file" accept="application/pdf,.pdf" id="pvfile" hidden></label>
      <p class="hint">In iCloud Drive › Library › ${where}</p>
      <p class="error" id="pverr"></p>
    </div>`;
    const err = (m) => { $("#pverr").textContent = m; };
    $("#pvdl")?.addEventListener("click", async (e) => {
      e.target.disabled = true;
      e.target.textContent = "Downloading… (iCloud may need a moment)";
      try {
        const blob = await download(b);
        await keep(b.id, blob);
        if (my === token) open(b, blob, page, rect, my);
      } catch (x) { err(`Download failed: ${x.message}`); e.target.disabled = false; e.target.textContent = "Download PDF"; }
    });
    $("#pvfile").addEventListener("change", async (e) => {
      const f = e.target.files[0];
      if (!f) return;
      if (b.size && f.size !== b.size && !confirm(`This file is ${mb(f.size)}, the library copy is ${mb(b.size)}. Use it anyway?`)) return;
      await keep(b.id, f);
      if (my === token) open(b, f, page, rect, my);
    });
  };

  const open = async (b, blob, page, rect, my) => {
    const body = $("#pvbody");
    body.innerHTML = `<p class="muted pv-msg">Opening…</p>`;
    let d;
    try {
      const { getDocument } = await lib();
      d = await getDocument({ data: new Uint8Array(await blob.arrayBuffer()), standardFontDataUrl: PDFJS + "standard_fonts/" }).promise;
    } catch (x) { body.innerHTML = `<p class="error pv-msg">Could not open the PDF: ${esc(x.message)}</p>`; return; }
    if (my !== token) return d.destroy();
    doc?.destroy();
    doc = d; book = b; texts = new Map(); find = { q: "", hits: [], i: -1 };
    $("#pvtools").hidden = false;
    $("#pvof").textContent = doc.numPages;
    if (up === null) serverUp(); // for the highlight menu
    await layout();
    const foot = document.createElement("p");
    foot.className = "pv-foot";
    foot.innerHTML = `${doc.numPages} pages${blob.size ? ` · ${mb(blob.size)}` : ""} · kept on this device · <button class="link" data-act="forget">remove</button>`;
    body.append(foot);
    goto(page, rect);
  };

  // --- pages ---------------------------------------------------------------------------------------
  /** Page boxes at the current size; canvas and text layer are drawn when a page comes into view. */
  const layout = async () => {
    const body = $("#pvbody");
    const first = await doc.getPage(1);
    scale = Math.max(0.3, ((body.clientWidth - 24) / first.getViewport({ scale: 1 }).width) * zoom);
    observer?.disconnect();
    observer = new IntersectionObserver((es) => es.forEach((e) => e.isIntersecting && draw(e.target)), { root: body, rootMargin: "800px 0px" });
    const foot = body.querySelector(".pv-foot");
    body.innerHTML = "";
    pages = [];
    const vp = first.getViewport({ scale }); // other pages are sized like page 1 until drawn
    for (let n = 1; n <= doc.numPages; n++) {
      const box = document.createElement("div");
      box.className = "pv-p";
      box.dataset.n = n;
      box.style.width = `${vp.width}px`;
      box.style.height = `${vp.height}px`;
      box.style.setProperty("--scale-factor", scale);
      body.append(box);
      pages.push(box);
      observer.observe(box);
    }
    if (foot) body.append(foot);
  };

  const draw = async (box, force = false) => {
    if (!force && box.dataset.drawn === String(scale)) return;
    box.dataset.drawn = String(scale);
    const d = doc, page = await d.getPage(+box.dataset.n);
    const vp = page.getViewport({ scale });
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const c = document.createElement("canvas");
    c.width = Math.floor(vp.width * dpr);
    c.height = Math.floor(vp.height * dpr);
    box.style.width = `${vp.width}px`;
    box.style.height = `${vp.height}px`;
    await page.render({ canvasContext: c.getContext("2d"), viewport: vp, transform: dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : null }).promise;
    if (d !== doc) return;
    const tl = document.createElement("div");
    tl.className = "textLayer";
    const { TextLayer } = await lib();
    await new TextLayer({ textContentSource: page.streamTextContent(), container: tl, viewport: vp }).render().catch(() => {});
    box.vp = vp;
    box.replaceChildren(c, tl);
    if (target?.n === +box.dataset.n) mark(box, page);
    if (find.q) markHits(box);
  };

  /** Frames the annotation (rect in PDF points from the top-left, as PyMuPDF writes it). */
  const mark = (box, page) => {
    box.querySelector(".pv-mark")?.remove();
    if (!target?.rect) return;
    const [x0, y0, x1, y1] = target.rect, view = page.view; // view = [xMin, yMin, xMax, yMax] of the page box
    const m = document.createElement("div");
    m.className = "pv-mark";
    Object.assign(m.style, { left: `${(x0 - view[0]) * scale - 3}px`, top: `${(y0 - view[1]) * scale - 3}px`,
      width: `${(x1 - x0) * scale + 6}px`, height: `${(y1 - y0) * scale + 6}px` });
    box.append(m);
  };

  const goto = (n, rect) => {
    if (!doc) return;
    n = Math.min(Math.max(1, n || 1), doc.numPages);
    target = { n, rect };
    const box = pages[n - 1], body = $("#pvbody");
    el.querySelectorAll(".pv-mark").forEach((m) => m.remove());
    const y = rect ? Math.max(0, rect[1] * scale - 80) : 0;
    body.scrollTo({ top: box.offsetTop - body.offsetTop + y - 8 });
    if (box.vp) doc.getPage(n).then((p) => mark(box, p));
    pageLabel();
  };

  const current = () => {
    const body = $("#pvbody");
    const top = body.scrollTop + body.offsetTop + 40;
    return +((pages.findLast((p) => p.offsetTop <= top) || pages[0])?.dataset.n || 1);
  };
  const pageLabel = () => {
    const n = $("#pvn");
    if (doc && n && document.activeElement !== n) n.value = current();
  };

  // --- find ----------------------------------------------------------------------------------------
  const pageText = async (n) => {
    if (!texts.has(n)) texts.set(n, (await doc.getPage(n)).getTextContent().then((t) => t.items.map((i) => i.str).join(" ").toLowerCase()));
    return texts.get(n);
  };
  const runFind = async (q) => {
    q = q.trim().toLowerCase();
    if (q !== find.q) {
      find = { q, hits: [], i: -1 };
      el.querySelectorAll(".textLayer .hit").forEach((s) => s.classList.remove("hit"));
      if (!q) { $("#pvhits").textContent = ""; return; }
      $("#pvhits").textContent = "searching…";
      const d = doc;
      for (let n = 1; n <= d.numPages; n++) {
        const t = await pageText(n);
        if (d !== doc || q !== find.q) return;
        let k = 0;
        for (let i = t.indexOf(q); i >= 0; i = t.indexOf(q, i + q.length)) find.hits.push({ n, k: k++ });
      }
      pages.forEach((p) => p.vp && markHits(p));
    }
    step(1);
  };
  const step = (dir) => {
    if (!find.hits.length) { $("#pvhits").textContent = find.q ? "no match" : ""; return; }
    find.i = (find.i + dir + find.hits.length) % find.hits.length;
    $("#pvhits").textContent = `${find.i + 1} / ${find.hits.length}`;
    const { n, k } = find.hits[find.i], box = pages[n - 1], my = find.i;
    goto(n);
    // then to the word itself, once the page's text layer is there (the k-th match on that page)
    const toWord = (tries) => {
      if (find.i !== my) return;
      const spans = box.querySelectorAll(".textLayer span.hit");
      if (!spans.length) return tries && setTimeout(() => toWord(tries - 1), 150);
      el.querySelectorAll(".textLayer span.cur").forEach((s) => s.classList.remove("cur"));
      const s = spans[Math.min(k, spans.length - 1)], body = $("#pvbody");
      s.classList.add("cur");
      body.scrollTop += s.getBoundingClientRect().top - body.getBoundingClientRect().top - body.clientHeight / 3;
    };
    toWord(20);
  };
  /** Marks the text spans of a page that contain the search word. */
  const markHits = (box) => {
    box.querySelectorAll(".textLayer span").forEach((s) => s.classList.toggle("hit", !!find.q && s.textContent.toLowerCase().includes(find.q)));
  };

  // --- highlighting --------------------------------------------------------------------------------
  let sel = null; // { box, rects (PDF user space), text, bounds (screen) } of the current selection
  const readSelection = () => {
    const s = getSelection();
    if (!s || s.isCollapsed || !s.rangeCount) return null;
    const r = s.getRangeAt(0);
    const box = (r.startContainer.parentElement || r.startContainer).closest?.(".pv-p");
    if (!box || !el.contains(box) || !box.vp) return null;
    const b = box.getBoundingClientRect();
    const rects = [];
    for (const c of r.getClientRects()) {
      if (c.width < 1 || c.height < 1 || c.bottom < b.top || c.top > b.bottom) continue; // only this page
      const [x0, y0] = box.vp.convertToPdfPoint(c.left - b.left, c.top - b.top);
      const [x1, y1] = box.vp.convertToPdfPoint(c.right - b.left, c.bottom - b.top);
      const q = [Math.min(x0, x1), Math.min(y0, y1), Math.max(x0, x1), Math.max(y0, y1)];
      const last = rects.at(-1); // spans on one line become one rectangle
      if (last && Math.abs(last[1] - q[1]) < 2 && Math.abs(last[3] - q[3]) < 2 && q[0] <= last[2] + 4) last[2] = Math.max(last[2], q[2]);
      else rects.push(q);
    }
    return rects.length ? { box, rects, text: s.toString().replace(/\s+/g, " ").trim(), bounds: r.getBoundingClientRect() } : null;
  };
  const showMenu = () => {
    const menu = $("#pvmenu");
    sel = readSelection();
    if (!menu) return;
    if (!sel) { menu.hidden = true; return; }
    const e = el.getBoundingClientRect();
    menu.hidden = false;
    const w = menu.offsetWidth, h = menu.offsetHeight;
    menu.style.left = `${Math.min(Math.max(8, sel.bounds.left + sel.bounds.width / 2 - e.left - w / 2), e.width - w - 8)}px`;
    menu.style.top = `${Math.max(44, sel.bounds.top - e.top - h - 8)}px`;
    menu.querySelectorAll(".pv-dot").forEach((d) => {
      d.disabled = !up;
      d.title = up ? d.getAttribute("aria-label") : "Highlighting needs the PDF server on the laptop/PC (the PDF is written in the iCloud library)";
    });
    menu.querySelector('[data-act="note"]').disabled = !up;
  };
  const highlight = async (color, comment = "") => {
    if (!sel || !book) return;
    const { box, rects, text } = sel, n = +box.dataset.n, b = book;
    $("#pvmenu").hidden = true;
    getSelection().removeAllRanges();
    // show it at once; the server writes it into the PDF, then the page is drawn again from the new file
    const marks = rects.map(([x0, y0, x1, y1]) => {
      const [l, t] = box.vp.convertToViewportPoint(x0, y1), [r, bt] = box.vp.convertToViewportPoint(x1, y0);
      const m = document.createElement("div");
      m.className = "pv-new";
      Object.assign(m.style, { left: `${l}px`, top: `${t}px`, width: `${r - l}px`, height: `${bt - t}px`, background: color });
      box.append(m);
      return m;
    });
    try {
      const res = await fetch(`${SERVER}/annotate`, { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: b.path, page: n, rects, color: rgb(color), comment, text }) });
      const out = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(out.error || `server said ${res.status}`);
      // the annotation as the website lists it (the extractor's version replaces it after its next run)
      // rect from the top-left like PyMuPDF's (page.view = [xMin, yMin, xMax, yMax] in PDF user space)
      const view = (await doc.getPage(n)).view, top = (y) => view[3] - y + view[1];
      onHighlight?.(b, { id: `new-${Date.now()}`, page: n, type: "Highlight", color, comment: comment || null, author: out.author, text,
        created: new Date().toISOString().slice(0, 19), pending: true,
        rect: [Math.min(...rects.map((r) => r[0])), top(Math.max(...rects.map((r) => r[3]))), Math.max(...rects.map((r) => r[2])), top(Math.min(...rects.map((r) => r[1])))] });
      const blob = await download(b); // the file now has the highlight in it
      await keep(b.id, blob);
      if (book !== b) return;
      const at = $("#pvbody").scrollTop, d = await (await lib()).getDocument({ data: new Uint8Array(await blob.arrayBuffer()), standardFontDataUrl: PDFJS + "standard_fonts/" }).promise;
      if (book !== b) return d.destroy();
      doc.destroy();
      doc = d; texts = new Map();
      pages.forEach((p) => { delete p.dataset.drawn; delete p.vp; });
      await draw(box, true);
      $("#pvbody").scrollTop = at;
      pages.forEach((p) => { const r = p.getBoundingClientRect(), v = $("#pvbody").getBoundingClientRect(); if (p !== box && r.bottom > v.top - 800 && r.top < v.bottom + 800) draw(p, true); });
    } catch (x) {
      marks.forEach((m) => m.remove());
      alert(`The highlight was not saved: ${x.message}`);
    }
  };

  // --- maximize ------------------------------------------------------------------------------------
  let shade = null;
  const maximize = async (on = !el.classList.contains("max")) => {
    if (on === el.classList.contains("max")) return;
    const at = doc && current();
    if (on) {
      shade = document.createElement("div");
      shade.className = "pv-shade";
      shade.addEventListener("click", () => maximize(false));
      document.body.append(shade, el);
    } else {
      shade?.remove();
      home.parent.insertBefore(el, home.next);
    }
    el.classList.toggle("max", on);
    const btn = el.querySelector('[data-act="max"]');
    if (btn) { btn.textContent = on ? "⤡" : "⤢"; btn.title = on ? "Back to the side (Esc)" : "Maximize"; }
    if (doc) { await layout(); goto(at); }
  };

  // --- events --------------------------------------------------------------------------------------
  el.addEventListener("click", async (e) => {
    const act = e.target.closest("[data-act]")?.dataset.act;
    const z = e.target.closest("[data-z]");
    const dot = e.target.closest(".pv-dot");
    if (dot) return highlight(dot.dataset.color);
    if (act === "max") return maximize();
    if (act === "note") { const c = prompt("Note for this highlight:"); if (c !== null) highlight(COLORS[0][1], c); return; }
    if (act === "copy") { navigator.clipboard?.writeText(sel?.text || ""); $("#pvmenu").hidden = true; return; }
    if (act === "forget" && book) { const b = book; await forget(b.id); empty("Removed from this device."); return show(b, 1); }
    if (!doc) return;
    if (act === "prev" || act === "next") return goto(current() + (act === "next" ? 1 : -1));
    if (act === "find") { const f = $("#pvfind"); f.hidden = !f.hidden; if (!f.hidden) $("#pvq").focus(); return; }
    if (act === "hitnext" || act === "hitprev") return find.q ? step(act === "hitnext" ? 1 : -1) : runFind($("#pvq").value);
    if (act === "fit" || z) {
      const at = current();
      zoom = act === "fit" ? 1 : Math.min(4, Math.max(0.4, zoom * (z.dataset.z === "1" ? 1.25 : 0.8)));
      await layout();
      goto(at);
    }
  });
  el.addEventListener("keydown", (e) => {
    if (e.target.id === "pvq" && e.key === "Enter") { e.preventDefault(); runFind(e.target.value); }
    if (e.target.id === "pvn" && e.key === "Enter") { e.preventDefault(); goto(parseInt(e.target.value, 10)); e.target.blur(); }
  });
  el.addEventListener("scroll", () => requestAnimationFrame(pageLabel), true);
  el.addEventListener("pointerup", () => setTimeout(showMenu, 0));
  el.addEventListener("pointerdown", (e) => { if (!e.target.closest("#pvmenu")) $("#pvmenu") && ($("#pvmenu").hidden = true); });
  document.addEventListener("selectionchange", () => { if (getSelection()?.isCollapsed && $("#pvmenu")) $("#pvmenu").hidden = true; });
  const onKey = (e) => { if (e.key === "Escape" && el.classList.contains("max")) { e.stopImmediatePropagation(); maximize(false); } };
  document.addEventListener("keydown", onKey, true);
  let width = 0;
  new ResizeObserver(async () => { // a new pane width (window, maximize): fit the pages again
    const w = $("#pvbody")?.clientWidth || 0;
    if (!doc || Math.abs(w - width) < 30) return;
    width = w;
    const at = current();
    await layout();
    goto(at);
  }).observe(el);

  async function show(b, page, rect) {
    if (doc && book?.id === b.id) return goto(page, rect); // same book: just go there
    const my = ++token;
    doc?.destroy();
    doc = null; book = b; pages = [];
    el.innerHTML = shell(b);
    if (b.ext !== "pdf") { $("#pvbody").innerHTML = `<p class="muted pv-msg">This book is an ${esc(String(b.ext || "").toUpperCase())}, not a PDF.</p>`; return; }
    const blob = await (await stored(b.id))?.blob();
    if (my !== token) return;
    if (blob) open(b, blob, page, rect, my);
    else ask(b, page, rect, my);
  }

  empty("Pick a book in the timeline.");
  return {
    show,
    clear: () => { maximize(false); empty("Pick a book in the timeline."); },
    dispose: () => { document.removeEventListener("keydown", onKey, true); maximize(false); },
  };
}
