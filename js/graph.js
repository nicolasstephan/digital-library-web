// Graph view: books and authors as a force-directed network, like Obsidian's graph.
// Links: book–author, and "related" books whose titles and highlights share distinctive words (TF-IDF cosine).
// Notes and [[links]] (build step 4) become nodes and links here too.
// Tap a node to select it (neighbors stay lit, details card); double-click or "Open" goes to the book.

const STATE = "dl.graphView";
const MIN_SIM = 0.2; // cosine threshold for a "related" link
const TOP = 3; // related links per book
const STOP = new Set((
  "the and for with from that this which into their there these those about over under between through what when " +
  "where while than then them they have has had not but are was were been being its also can could would should will " +
  "may might must our your his her who whom how all any each more most other some such only own same very just one " +
  "two new part vol edition press university introduction chapter pdf eng " +
  "der die das und oder ein eine einer eines dem den des mit von fur auf aus bei nach uber unter zum zur ist sind war " +
  "wird werden nicht auch als wie sich dass sie ihr ihre sein seine"
).split(" "));

// --- Related books -------------------------------------------------------------------------------
/** TF-IDF vectors per book (title counted three times + all highlight and comment text). */
function vectors(books, rows, fold) {
  const tokens = (s) => (fold(s).match(/\p{L}{3,}/gu) || []).filter((w) => !STOP.has(w));
  const words = new Map(books.map((b) => { const t = tokens(b.title); return [b.id, [...t, ...t, ...t]]; }));
  for (const r of rows) words.get(r.b)?.push(...tokens(`${r.x || ""} ${r.m || ""}`));
  const tf = new Map(), df = new Map();
  for (const [id, ws] of words) {
    const m = new Map();
    for (const w of ws) m.set(w, (m.get(w) || 0) + 1);
    tf.set(id, m);
    for (const w of m.keys()) df.set(w, (df.get(w) || 0) + 1);
  }
  // words in one book link nothing; words in many books link everything
  const n = words.size, maxDf = Math.max(3, n * 0.05);
  const vec = new Map(), postings = new Map();
  for (const [id, m] of tf) {
    const v = new Map();
    let norm = 0;
    for (const [w, c] of m) {
      const d = df.get(w);
      if (d < 2 || d > maxDf) continue;
      const x = (1 + Math.log(c)) * Math.log(n / d);
      v.set(w, x);
      norm += x * x;
    }
    norm = Math.sqrt(norm) || 1;
    for (const [w, x] of v) {
      v.set(w, x / norm);
      (postings.get(w) || postings.set(w, []).get(w)).push(id);
    }
    vec.set(id, v);
  }
  return { vec, postings };
}

function relatedPairs({ vec, postings }) {
  const pairs = new Map();
  for (const [id, v] of vec) {
    const score = new Map();
    for (const [w, x] of v) for (const o of postings.get(w)) if (o !== id) score.set(o, (score.get(o) || 0) + x * vec.get(o).get(w));
    [...score].filter(([, s]) => s >= MIN_SIM).sort((a, b) => b[1] - a[1]).slice(0, TOP)
      .forEach(([o, s]) => pairs.set([id, o].sort().join(" "), s));
  }
  return pairs;
}

/** The words that make two books related, strongest first. */
function sharedWords({ vec }, a, b, k = 5) {
  const va = vec.get(a), vb = vec.get(b);
  if (!va || !vb) return [];
  return [...va].filter(([w]) => vb.has(w)).map(([w, x]) => [w, x * vb.get(w)]).sort((p, q) => q[1] - p[1]).slice(0, k).map(([w]) => w);
}

// --- Graph model ---------------------------------------------------------------------------------
function buildGraph(books, related, opts, old) {
  const nodes = new Map(), links = [];
  const keep = (b) => opts.show !== "annotated" || b.annotations;
  const node = (id, props) => {
    if (!nodes.has(id)) {
      const prev = old?.get(id);
      nodes.set(id, { id, x: prev?.x ?? (Math.random() - 0.5) * 400, y: prev?.y ?? (Math.random() - 0.5) * 400, vx: 0, vy: 0, deg: 0, ...props });
    }
    return nodes.get(id);
  };
  for (const b of books) if (keep(b)) node(b.id, { kind: "book", label: b.title, book: b });
  if (opts.authors) {
    for (const b of books) {
      if (!keep(b)) continue;
      for (const a of b.authors || []) {
        const n = node("a:" + a, { kind: "author", label: a, books: [] });
        n.books.push(b);
        links.push({ s: n, t: nodes.get(b.id), kind: "author" });
      }
    }
  }
  if (opts.related) {
    for (const [key, s] of related) {
      const [a, b] = key.split(" ");
      if (nodes.has(a) && nodes.has(b)) links.push({ s: nodes.get(a), t: nodes.get(b), kind: "related", w: s });
    }
  }
  const adj = new Map([...nodes.keys()].map((id) => [id, new Set()]));
  for (const l of links) { l.s.deg++; l.t.deg++; adj.get(l.s.id).add(l.t.id); adj.get(l.t.id).add(l.s.id); }
  for (const n of nodes.values()) {
    n.r = n.kind === "author" ? 3 + Math.sqrt(n.books.length) * 1.6
      : n.book.annotations ? Math.min(14, 4 + Math.sqrt(n.book.annotations) * 1.1) : 3;
  }
  return { nodes: [...nodes.values()], byId: nodes, links, adj };
}

/** One step of the force layout: repulsion between all nodes, springs along links, gravity to the center. */
function tick(g, alpha) {
  const ns = g.nodes;
  for (let i = 0; i < ns.length; i++) {
    const a = ns[i];
    for (let j = i + 1; j < ns.length; j++) {
      const b = ns[j];
      let dx = b.x - a.x, dy = b.y - a.y, d2 = dx * dx + dy * dy;
      if (d2 > 40000) continue; // 200 units: far nodes no longer push
      if (d2 < 1) { dx = Math.random() - 0.5; dy = Math.random() - 0.5; d2 = 1; }
      const f = (alpha * 500) / d2;
      a.vx -= dx * f; a.vy -= dy * f; b.vx += dx * f; b.vy += dy * f;
    }
  }
  for (const l of g.links) {
    const dx = l.t.x - l.s.x, dy = l.t.y - l.s.y, d = Math.sqrt(dx * dx + dy * dy) || 1;
    const len = l.kind === "author" ? 28 : 60;
    const f = ((d - len) / d) * alpha * (l.kind === "author" ? 0.5 : 0.25 * l.w * 3);
    const ws = l.t.deg / (l.s.deg + l.t.deg); // the lighter end moves more
    l.s.vx += dx * f * ws; l.s.vy += dy * f * ws; l.t.vx -= dx * f * (1 - ws); l.t.vy -= dy * f * (1 - ws);
  }
  for (const n of ns) {
    n.vx -= n.x * 0.015 * alpha; n.vy -= n.y * 0.015 * alpha;
    if (n.fixed) { n.vx = n.vy = 0; continue; }
    n.vx *= 0.6; n.vy *= 0.6;
    n.x += n.vx; n.y += n.vy;
  }
}

// --- View ----------------------------------------------------------------------------------------
export async function viewGraph(main, { books, lib, esc, fold, load, save, openAuthor }) {
  const opts = load(STATE, { show: "all", authors: true, related: true });
  main.classList.add("wide");
  main.innerHTML = `
    <div class="toolbar">
      <input id="gq" type="search" placeholder="Find in graph" autocomplete="off">
      <div class="seg" role="group" aria-label="Books">
        ${[["all", "All books"], ["annotated", "Annotated"]].map(([k, l]) => `<button data-show="${k}" aria-pressed="${opts.show === k}">${l}</button>`).join("")}
      </div>
      <div class="seg" role="group" aria-label="Links">
        <button data-opt="authors" aria-pressed="${opts.authors}">Authors</button>
        <button data-opt="related" aria-pressed="${opts.related}">Related</button>
      </div>
    </div>
    <p class="count" id="count">Building the graph…</p>
    <div class="graph" id="wrap">
      <canvas id="cv" aria-label="Graph of books and authors"></canvas>
      <div class="legend"><span class="dot dot-book"></span>book <span class="dot dot-author"></span>author <span class="dot dot-unread"></span>not read yet</div>
      <button class="ghost fit" id="fit" title="Fit to screen">Fit</button>
      <aside class="card" id="card" hidden></aside>
    </div>`;
  const wrap = main.querySelector("#wrap"), cv = main.querySelector("#cv"), card = main.querySelector("#card");
  const ctx = cv.getContext("2d");

  let rows = [];
  try { rows = await lib.search(); } catch { /* offline without search.json: author links only */ }
  if (!cv.isConnected) return;
  const vs = vectors(books, rows, fold);
  const related = relatedPairs(vs);

  let g, alpha = 1, view = { k: 1, x: 0, y: 0 }, W = 0, H = 0;
  let hover = null, selected = null, query = [];
  let colors = {};
  const readColors = () => {
    const css = getComputedStyle(document.documentElement);
    for (const k of ["bg", "text", "muted", "border", "accent", "node-author", "node-unread", "surface"]) colors[k] = css.getPropertyValue("--" + k).trim();
  };
  readColors();

  const rebuild = () => {
    save(STATE, opts);
    g = buildGraph(books, related, opts, g?.byId);
    if (selected) selected = g.byId.get(selected.id) || null;
    const nb = g.nodes.filter((n) => n.kind === "book").length;
    main.querySelector("#count").textContent =
      `${nb} books · ${g.nodes.length - nb} authors · ${g.links.length} links` + (rows.length ? "" : " · related links need search.json (offline?)");
    alpha = 1;
    for (let i = 0; i < 150; i++) tick(g, alpha *= 0.985); // settle before the first frame
    fit();
    showCard();
    kick();
  };

  // --- drawing
  const resize = () => {
    const r = wrap.getBoundingClientRect(), dpr = window.devicePixelRatio || 1;
    W = r.width; H = r.height;
    cv.width = W * dpr; cv.height = H * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    draw();
  };
  function fit() {
    if (!g?.nodes.length || !W) return;
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const n of g.nodes) { x0 = Math.min(x0, n.x); y0 = Math.min(y0, n.y); x1 = Math.max(x1, n.x); y1 = Math.max(y1, n.y); }
    view.k = Math.min(3, 0.9 * Math.min(W / (x1 - x0 || 1), H / (y1 - y0 || 1)));
    view.x = W / 2 - view.k * (x0 + x1) / 2;
    view.y = H / 2 - view.k * (y0 + y1) / 2;
  }
  const lit = () => {
    const focus = hover || selected;
    if (focus) return new Set([focus.id, ...g.adj.get(focus.id)]);
    if (query.length) return new Set(g.nodes.filter((n) => query.every((w) => fold(n.label).includes(w))).map((n) => n.id));
    return null;
  };
  function draw() {
    if (!g) return;
    ctx.clearRect(0, 0, W, H);
    ctx.save();
    ctx.translate(view.x, view.y);
    ctx.scale(view.k, view.k);
    const on = lit();
    ctx.lineWidth = 1 / view.k;
    for (const l of g.links) {
      const focus = hover || selected;
      const hot = focus ? l.s === focus || l.t === focus : on && on.has(l.s.id) && on.has(l.t.id);
      ctx.globalAlpha = on ? (hot ? 0.9 : 0.06) : l.kind === "related" ? 0.35 : 0.5;
      ctx.strokeStyle = l.kind === "related" ? colors.accent : colors.muted;
      ctx.setLineDash(l.kind === "related" ? [4 / view.k, 3 / view.k] : []);
      ctx.beginPath(); ctx.moveTo(l.s.x, l.s.y); ctx.lineTo(l.t.x, l.t.y); ctx.stroke();
    }
    ctx.setLineDash([]);
    for (const n of g.nodes) {
      ctx.globalAlpha = on && !on.has(n.id) ? 0.15 : 1;
      ctx.fillStyle = n.kind === "author" ? colors["node-author"] : n.book.read ? colors.accent : colors["node-unread"];
      ctx.beginPath(); ctx.arc(n.x, n.y, size(n), 0, Math.PI * 2); ctx.fill();
      if (n === selected) { ctx.strokeStyle = colors.text; ctx.lineWidth = 2 / view.k; ctx.stroke(); ctx.lineWidth = 1 / view.k; }
    }
    ctx.restore();
    // labels in screen space, so they stay readable at any zoom
    ctx.globalAlpha = 1;
    ctx.font = "12px system-ui, -apple-system, 'Segoe UI', sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "top";
    // the focused node first, then the biggest; a label that would overlap one already drawn is skipped
    const focus = hover || selected, boxes = [];
    const order = g.nodes.filter((n) => on ? on.has(n.id) : n.r * view.k > 9 || (view.k > 2.2 && n.r * view.k > 5))
      .sort((a, b) => (b === focus) - (a === focus) || b.r - a.r);
    for (const n of order) {
      const x = view.x + n.x * view.k, y = view.y + (n.y + size(n)) * view.k + 3;
      if (x < -100 || x > W + 100 || y < -20 || y > H + 20) continue;
      const t = n.label.length > 42 ? n.label.slice(0, 40) + "…" : n.label;
      const w = ctx.measureText(t).width, box = [x - w / 2 - 2, y, x + w / 2 + 2, y + 15];
      if (boxes.some((o) => box[0] < o[2] && box[2] > o[0] && box[1] < o[3] && box[3] > o[1])) continue;
      boxes.push(box);
      ctx.lineWidth = 3; ctx.strokeStyle = colors.bg; ctx.strokeText(t, x, y);
      ctx.fillStyle = n === hover || n === selected ? colors.text : colors.muted;
      ctx.fillText(t, x, y);
    }
  }
  let frame = 0;
  function kick() {
    if (frame) return;
    const loop = () => {
      frame = 0;
      if (!cv.isConnected) return cleanup();
      if (alpha > 0.02) { tick(g, alpha); alpha *= 0.985; frame = requestAnimationFrame(loop); }
      draw();
    };
    frame = requestAnimationFrame(loop);
  }

  // --- details card
  function showCard() {
    const n = selected;
    card.hidden = !n;
    if (!n) return;
    const item = (m) => `<li><button class="link" data-sel="${esc(m.id)}">${esc(m.label)}</button>${m.why ? ` <span class="muted">${esc(m.why)}</span>` : ""}</li>`;
    const nb = [...g.adj.get(n.id)].map((id) => g.byId.get(id));
    if (n.kind === "author") {
      card.innerHTML = `<button class="close" id="cx" aria-label="Close">×</button>
        <h2>${esc(n.label)}</h2>
        <p class="meta">${n.books.length} ${n.books.length === 1 ? "book" : "books"}</p>
        <ul>${n.books.map((b) => item(g.byId.get(b.id))).join("")}</ul>
        <button class="ghost" id="lib">Show in library</button>`;
      card.querySelector("#lib").onclick = () => openAuthor(n.label);
    } else {
      const b = n.book;
      const rel = nb.filter((m) => m.kind === "book").map((m) => ({ ...m, why: sharedWords(vs, b.id, m.id, 3).join(", ") }));
      card.innerHTML = `<button class="close" id="cx" aria-label="Close">×</button>
        <h2><a href="#/book/${esc(b.id)}">${esc(b.title)}</a></h2>
        <p class="meta">${esc([(b.authors || []).join(", "), b.year].filter(Boolean).join(" · "))}
          · ${b.annotations ? `${b.annotations} annotations` : b.read ? "no annotations" : "not read yet"}</p>
        ${rel.length ? `<h3>Related</h3><ul>${rel.map(item).join("")}</ul>` : ""}
        <a class="open" href="#/book/${esc(b.id)}">Open →</a>`;
    }
    card.querySelector("#cx").onclick = () => { selected = null; showCard(); draw(); };
    card.querySelectorAll("[data-sel]").forEach((el) => el.onclick = () => {
      selected = g.byId.get(el.dataset.sel);
      view.x = W / 2 - selected.x * view.k; view.y = H / 2 - selected.y * view.k;
      showCard(); draw();
    });
  }

  // --- pointer: pan, pinch, drag nodes, select
  const size = (n) => Math.max(n.r, 2.5 / view.k); // never smaller than 2.5 px on screen
  const world = (e) => { const r = cv.getBoundingClientRect(); return [(e.clientX - r.left - view.x) / view.k, (e.clientY - r.top - view.y) / view.k]; };
  const hit = (e) => {
    const [x, y] = world(e);
    let best = null, bd = Infinity;
    for (const n of g.nodes) {
      const d = Math.hypot(n.x - x, n.y - y);
      if (d < size(n) + 6 / view.k && d < bd) { best = n; bd = d; }
    }
    return best;
  };
  const zoomAt = (sx, sy, f) => {
    const k = Math.max(0.1, Math.min(8, view.k * f));
    view.x = sx - (sx - view.x) * (k / view.k); view.y = sy - (sy - view.y) * (k / view.k); view.k = k;
    draw();
  };
  const pts = new Map();
  let drag = null, moved = 0, pinch = null;
  cv.addEventListener("pointerdown", (e) => {
    try { cv.setPointerCapture(e.pointerId); } catch { /* unknown pointer (Firefox): drag still works inside the canvas */ }
    pts.set(e.pointerId, [e.clientX, e.clientY]);
    moved = 0;
    if (pts.size === 2) {
      const [a, b] = [...pts.values()];
      pinch = { d: Math.hypot(a[0] - b[0], a[1] - b[1]) };
      if (drag?.node) drag.node.fixed = false;
      drag = null;
      return;
    }
    const n = hit(e);
    drag = n ? { node: n } : { pan: true };
    if (n) n.fixed = true;
  });
  cv.addEventListener("pointermove", (e) => {
    const prev = pts.get(e.pointerId);
    if (!prev) {
      const n = hit(e);
      if (n !== hover) { hover = n; cv.style.cursor = n ? "pointer" : "grab"; draw(); }
      return;
    }
    const dx = e.clientX - prev[0], dy = e.clientY - prev[1];
    pts.set(e.pointerId, [e.clientX, e.clientY]);
    moved += Math.abs(dx) + Math.abs(dy);
    if (pinch && pts.size === 2) {
      const [a, b] = [...pts.values()], d = Math.hypot(a[0] - b[0], a[1] - b[1]);
      const r = cv.getBoundingClientRect();
      zoomAt((a[0] + b[0]) / 2 - r.left, (a[1] + b[1]) / 2 - r.top, d / pinch.d);
      pinch.d = d;
    } else if (drag?.node && moved > 3) {
      [drag.node.x, drag.node.y] = world(e);
      alpha = Math.max(alpha, 0.3); kick();
    } else if (drag?.pan) {
      view.x += dx; view.y += dy; draw();
    }
  });
  const up = (e) => {
    pts.delete(e.pointerId);
    if (pts.size < 2) pinch = null;
    if (!drag) return;
    if (drag.node) drag.node.fixed = false;
    if (moved <= 3) { selected = drag.node || null; showCard(); draw(); }
    drag = null;
  };
  cv.addEventListener("pointerup", up);
  cv.addEventListener("pointercancel", up);
  cv.addEventListener("pointerleave", () => { if (hover && !pts.size) { hover = null; draw(); } });
  cv.addEventListener("dblclick", (e) => {
    const n = hit(e);
    if (n?.kind === "book") location.hash = `#/book/${n.id}`;
    else if (n) openAuthor(n.label);
  });
  cv.addEventListener("wheel", (e) => {
    e.preventDefault();
    const r = cv.getBoundingClientRect();
    zoomAt(e.clientX - r.left, e.clientY - r.top, Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.0015)));
  }, { passive: false });

  // --- controls
  let qt;
  main.querySelector("#gq").addEventListener("input", (e) => {
    clearTimeout(qt);
    qt = setTimeout(() => { query = fold(e.target.value).split(/\s+/).filter(Boolean); draw(); }, 120);
  });
  main.querySelectorAll("[data-show]").forEach((btn) => btn.addEventListener("click", () => {
    opts.show = btn.dataset.show;
    main.querySelectorAll("[data-show]").forEach((b) => b.setAttribute("aria-pressed", b === btn));
    rebuild();
  }));
  main.querySelectorAll("[data-opt]").forEach((btn) => btn.addEventListener("click", () => {
    opts[btn.dataset.opt] = !opts[btn.dataset.opt];
    btn.setAttribute("aria-pressed", opts[btn.dataset.opt]);
    rebuild();
  }));
  main.querySelector("#fit").addEventListener("click", () => { fit(); draw(); });

  const ro = new ResizeObserver(resize);
  ro.observe(wrap);
  const mq = matchMedia("(prefers-color-scheme: dark)");
  const onTheme = () => { readColors(); draw(); };
  mq.addEventListener("change", onTheme);
  function cleanup() { cancelAnimationFrame(frame); ro.disconnect(); mq.removeEventListener("change", onTheme); }
  main.dispose = cleanup;

  const r = wrap.getBoundingClientRect();
  W = r.width; H = r.height;
  rebuild();
}
