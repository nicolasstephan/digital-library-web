// PDF viewer pane (PDF.js, vendored in vendor/pdfjs): opens a book at a page and frames the annotation there.
// The PDFs are not in the data repo. A PDF comes from the browser's own store (Cache API "dl-pdf-v1", kept per
// device after the first time), else from the local PDF server on the laptop/PC (pdfserver.py, 127.0.0.1:8767,
// reads the iCloud library), else the person picks the file (iPhone/iPad: Files > iCloud Drive > Library).

const STORE = "dl-pdf-v1";
const SERVER = "http://127.0.0.1:8767";
const PDFJS = new URL("../vendor/pdfjs/", import.meta.url).href;

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
async function serverUp() {
  try { return (await fetch(`${SERVER}/ping`, { signal: AbortSignal.timeout(800) })).ok; } catch { return false; }
}
const mb = (n) => `${(n / 1048576).toFixed(n < 10485760 ? 1 : 0)} MB`;

/** A viewer in `el`. open(book, page, rect) shows that page (loading or asking for the PDF first). */
export function pdfViewer(el, { esc, onClose }) {
  let doc = null, bookId = null, pages = [], scale = 1, zoom = 1, observer = null, target = null, token = 0;

  const shell = (b) => `
    <div class="pv-bar">
      <span class="pv-title" title="${esc(b.title)}">${esc(b.title)}</span>
      <span class="pv-page" id="pvpage"></span>
      <button class="pv-btn" data-z="-1" title="Smaller" aria-label="Smaller">−</button>
      <button class="pv-btn" data-z="1" title="Larger" aria-label="Larger">+</button>
      <button class="pv-btn pv-close" title="Close the PDF" aria-label="Close">×</button>
    </div>
    <div class="pv-body" id="pvbody"></div>`;

  const ask = async (b, page, rect, my) => {
    const body = el.querySelector("#pvbody");
    body.innerHTML = `<p class="muted pv-msg">Checking for the PDF…</p>`;
    const up = await serverUp();
    if (my !== token) return;
    const where = esc(String(b.path).replace(/\\/g, " › "));
    body.innerHTML = `<div class="pv-get">
      <p>This PDF is not on this device yet${b.size ? ` (${mb(b.size)})` : ""}.</p>
      ${up ? `<button class="primary" id="pvdl">Download PDF</button>
              <p class="hint">from the iCloud library on this computer</p>` : ""}
      <label class="${up ? "pv-alt" : "primary pv-pick"}">${up ? "or choose the file…" : "Choose PDF…"}
        <input type="file" accept="application/pdf,.pdf" id="pvfile" hidden></label>
      <p class="hint">In iCloud Drive › Library › ${where}</p>
      <p class="error" id="pverr"></p>
    </div>`;
    const err = (m) => { body.querySelector("#pverr").textContent = m; };
    body.querySelector("#pvdl")?.addEventListener("click", async (e) => {
      e.target.disabled = true;
      e.target.textContent = "Downloading… (iCloud may need a moment)";
      try {
        const r = await fetch(`${SERVER}/pdf?path=${encodeURIComponent(b.path)}`);
        if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `server said ${r.status}`);
        const blob = await r.blob();
        await keep(b.id, blob);
        if (my === token) show(b, blob, page, rect, my);
      } catch (x) { err(`Download failed: ${x.message}`); e.target.disabled = false; e.target.textContent = "Download PDF"; }
    });
    body.querySelector("#pvfile").addEventListener("change", async (e) => {
      const f = e.target.files[0];
      if (!f) return;
      if (b.size && f.size !== b.size && !confirm(`This file is ${mb(f.size)}, the library copy is ${mb(b.size)}. Use it anyway?`)) return;
      await keep(b.id, f);
      if (my === token) show(b, f, page, rect, my);
    });
  };

  const show = async (b, blob, page, rect, my) => {
    const body = el.querySelector("#pvbody");
    body.innerHTML = `<p class="muted pv-msg">Opening…</p>`;
    try {
      const { getDocument } = await lib();
      doc = await getDocument({ data: new Uint8Array(await blob.arrayBuffer()), standardFontDataUrl: PDFJS + "standard_fonts/" }).promise;
    } catch (x) { body.innerHTML = `<p class="error pv-msg">Could not open the PDF: ${esc(x.message)}</p>`; return; }
    if (my !== token) return;
    bookId = b.id;
    const foot = document.createElement("p");
    foot.className = "pv-foot";
    foot.innerHTML = `${doc.numPages} pages${blob.size ? ` · ${mb(blob.size)}` : ""} · kept on this device · <button class="link" id="pvforget">remove</button>`;
    await layout();
    body.append(foot);
    foot.querySelector("#pvforget").addEventListener("click", async () => { await forget(b.id); close(); });
    goto(page, rect);
  };

  /** Page boxes at the current size; canvases are drawn when a page comes into view. */
  const layout = async () => {
    const body = el.querySelector("#pvbody");
    const first = await doc.getPage(1);
    const w = first.getViewport({ scale: 1 }).width;
    scale = Math.max(0.3, ((body.clientWidth - 24) / w) * zoom);
    observer?.disconnect();
    observer = new IntersectionObserver((es) => es.forEach((e) => e.isIntersecting && draw(e.target)), { root: body, rootMargin: "800px 0px" });
    body.innerHTML = "";
    pages = [];
    for (let n = 1; n <= doc.numPages; n++) {
      const p = n === 1 ? first : null;
      const box = document.createElement("div");
      box.className = "pv-p";
      box.dataset.n = n;
      const vp = (p || first).getViewport({ scale }); // other pages are sized like page 1 until drawn
      box.style.width = `${vp.width}px`;
      box.style.height = `${vp.height}px`;
      body.append(box);
      pages.push(box);
      observer.observe(box);
    }
  };

  const draw = async (box) => {
    if (box.dataset.drawn === String(scale)) return;
    box.dataset.drawn = String(scale);
    const page = await doc.getPage(+box.dataset.n);
    const vp = page.getViewport({ scale });
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const c = document.createElement("canvas");
    c.width = Math.floor(vp.width * dpr);
    c.height = Math.floor(vp.height * dpr);
    box.style.width = `${vp.width}px`;
    box.style.height = `${vp.height}px`;
    await page.render({ canvasContext: c.getContext("2d"), viewport: vp, transform: dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : null }).promise;
    box.querySelector("canvas")?.remove();
    box.prepend(c);
    if (target?.n === +box.dataset.n) mark(box, page);
  };

  /** Frames the annotation (rect in PDF points from the top-left, as PyMuPDF writes it). */
  const mark = (box, page) => {
    box.querySelector(".pv-mark")?.remove();
    if (!target?.rect) return;
    const [x0, y0, x1, y1] = target.rect, view = page.view; // view = [x, y, w, h] of the page box
    const m = document.createElement("div");
    m.className = "pv-mark";
    Object.assign(m.style, { left: `${(x0 - view[0]) * scale - 3}px`, top: `${(y0 - view[1]) * scale - 3}px`,
      width: `${(x1 - x0) * scale + 6}px`, height: `${(y1 - y0) * scale + 6}px` });
    box.append(m);
  };

  const goto = (n, rect) => {
    n = Math.min(Math.max(1, n || 1), doc.numPages);
    target = { n, rect };
    const box = pages[n - 1], body = el.querySelector("#pvbody");
    el.querySelectorAll(".pv-mark").forEach((m) => m.remove());
    const y = rect ? Math.max(0, rect[1] * scale - 80) : 0;
    body.scrollTo({ top: box.offsetTop - body.offsetTop + y - 8 });
    if (box.querySelector("canvas")) doc.getPage(n).then((p) => mark(box, p));
    pageLabel();
  };

  const pageLabel = () => {
    const body = el.querySelector("#pvbody"), label = el.querySelector("#pvpage");
    if (!doc || !body || !label) return;
    const top = body.scrollTop + body.offsetTop + 40;
    const cur = pages.findLast((p) => p.offsetTop <= top) || pages[0];
    label.textContent = `p. ${cur.dataset.n} / ${doc.numPages}`;
  };

  const close = () => {
    token++;
    observer?.disconnect();
    doc?.destroy();
    doc = null; bookId = null; pages = [];
    el.innerHTML = "";
    el.hidden = true;
    onClose?.();
  };

  el.addEventListener("click", async (e) => {
    if (e.target.closest(".pv-close")) return close();
    const z = e.target.closest("[data-z]");
    if (z && doc) {
      const at = target?.n || 1;
      zoom = Math.min(4, Math.max(0.4, zoom * (z.dataset.z === "1" ? 1.25 : 0.8)));
      await layout();
      goto(at, target?.rect);
    }
  });
  el.addEventListener("scroll", () => requestAnimationFrame(pageLabel), true);

  return {
    get open() { return !el.hidden; },
    close,
    async show(b, page, rect) {
      el.hidden = false;
      if (doc && bookId === b.id) return goto(page, rect); // same book: just go there
      const my = ++token;
      doc?.destroy();
      doc = null; bookId = null;
      el.innerHTML = shell(b);
      const blob = await (await stored(b.id))?.blob();
      if (my !== token) return;
      if (blob) show(b, blob, page, rect, my);
      else ask(b, page, rect, my);
    },
  };
}
