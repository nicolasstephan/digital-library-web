// Graph view: books as a force-directed network, like Obsidian's graph, connected by what they have in common.
// "Connect by" picks the relations (several at once): shared author, topic, project, place, period, people, type,
// decade or collection become small hub nodes the books hang off; shared distinctive words (TF-IDF cosine on
// titles and highlights) are dashed links; citations are arrows (citations.json from tools/citations.py).
// Books on the want-to-read list get a ring. Tap a node to select it (its neighbors stay lit, the card says why books are related); double-click opens it.

const STATE = "dl.graphView";
const MIN_SIM = 0.2; // cosine threshold for a "shared words" link
const TOP = 3; // shared-words links per book
const CELL = 200; // repulsion reach: nodes farther apart no longer push (also the grid cell size)
const STOP = new Set((
  "the and for with from that this which into their there these those about over under between through what when " +
  "where while than then them they have has had not but are was were been being its also can could would should will " +
  "may might must our your his her who whom how all any each more most other some such only own same very just one " +
  "two new part vol edition press university introduction chapter pdf eng " +
  "der die das und oder ein eine einer eines dem den des mit von fur auf aus bei nach uber unter zum zur ist sind war " +
  "wird werden nicht auch als wie sich dass sie ihr ihre sein seine"
).split(" "));

// --- Connectors ----------------------------------------------------------------------------------
const facet = (b, f) => { const v = b.meta?.[f]; return v == null ? [] : [].concat(v); };
/** values(b) → the hub values a book hangs off; connectors without values link books directly. */
const CONNECT = [
  { key: "author", code: "AU", label: "Author", color: "node-author", values: (b) => (b.names || b.authors || []).filter((a) => a !== "et al.") },
  { key: "tags", code: "TO", label: "Topic", color: "c-topic", values: (b) => facet(b, "tags"), tag: true },
  { key: "project", code: "PR", label: "Project", color: "c-project", values: (b) => facet(b, "project"), tag: true },
  { key: "place", code: "PL", label: "Place", color: "c-place", values: (b) => facet(b, "place"), tag: true },
  { key: "period", code: "PE", label: "Period", color: "c-period", values: (b) => facet(b, "period"), tag: true },
  { key: "people", code: "PP", label: "People", color: "c-people", values: (b) => facet(b, "people"), tag: true },
  { key: "type", code: "TY", label: "Type", color: "c-type", values: (b) => facet(b, "type"), tag: true },
  { key: "decade", code: "DE", label: "Decade", color: "c-decade", values: (b) => b.year ? [`${Math.floor(b.year / 10) * 10}s`] : [] },
  { key: "collection", code: "CO", label: "Collection", color: "c-collection", values: (b) => b.collection && b.collection !== "Authors" ? [b.collection] : [] },
  { key: "words", label: "Shared words", color: "accent" },
  { key: "cites", label: "Citations", color: "text" },
];
const CONN = Object.fromEntries(CONNECT.map((c) => [c.key, c]));

// --- Shared words --------------------------------------------------------------------------------
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
/** Start position from the id, so the same books always settle into the same picture. */
function seeded(id) {
  let h = 2166136261;
  for (let i = 0; i < id.length; i++) h = Math.imul(h ^ id.charCodeAt(i), 16777619);
  const a = (h >>> 0) / 2 ** 32, b = (Math.imul(h, 2654435761) >>> 0) / 2 ** 32;
  return [(a - 0.5) * 400, (b - 0.5) * 400];
}

function buildGraph(books, { related, cites }, opts, old) {
  const nodes = new Map(), links = [];
  const on = new Set(opts.connect);
  const node = (id, props) => {
    if (!nodes.has(id)) {
      const prev = old?.get(id), [x, y] = seeded(id);
      nodes.set(id, { id, x: prev?.x ?? x, y: prev?.y ?? y, vx: 0, vy: 0, deg: 0, ...props });
    }
    return nodes.get(id);
  };
  const shown = books.filter((b) => (opts.show !== "annotated" || b.annotations) && (opts.show !== "want" || b.want));
  for (const b of shown) node(b.id, { kind: "book", label: b.title, book: b });
  for (const c of CONNECT) {
    if (!c.values || !on.has(c.key)) continue;
    const groups = new Map();
    for (const b of shown) for (const v of c.values(b)) (groups.get(v) || groups.set(v, []).get(v)).push(b);
    for (const [v, bs] of groups) {
      if (bs.length < 2) continue; // a value only one book has relates nothing
      const h = node(`${c.key}:${v}`, { kind: "hub", conn: c, label: v, books: bs });
      for (const b of bs) links.push({ s: h, t: nodes.get(b.id), conn: c });
    }
  }
  const pair = (c, a, b, extra) => { if (a !== b && nodes.has(a) && nodes.has(b)) links.push({ s: nodes.get(a), t: nodes.get(b), conn: c, ...extra }); };
  if (on.has("words")) for (const [key, w] of related) { const [a, b] = key.split(" "); pair(CONN.words, a, b, { w }); }
  if (on.has("cites")) for (const c of cites?.links || []) pair(CONN.cites, c.from, c.to, { cite: c });
  for (const l of links) { l.s.deg++; l.t.deg++; }
  if (opts.lonely === false) for (const [id, n] of nodes) if (!n.deg) nodes.delete(id);
  const adj = new Map([...nodes.keys()].map((id) => [id, new Set()]));
  for (const l of links) { adj.get(l.s.id).add(l.t.id); adj.get(l.t.id).add(l.s.id); }
  for (const n of nodes.values()) {
    n.r = n.kind === "hub" ? 2.5 + Math.sqrt(n.books.length) * 1.5
      : n.book.annotations ? Math.min(14, 4 + Math.sqrt(n.book.annotations) * 1.1) : 3;
  }
  return { nodes: [...nodes.values()], byId: nodes, links, adj };
}

/** One step of the force layout: repulsion between nearby nodes (grid, not all pairs), springs, gravity. */
function tick(g, alpha) {
  const grid = new Map();
  for (const n of g.nodes) {
    const cx = Math.floor(n.x / CELL), cy = Math.floor(n.y / CELL), k = `${cx},${cy}`;
    (grid.get(k) || grid.set(k, { cx, cy, ns: [] }).get(k)).ns.push(n);
  }
  const push = (a, b) => {
    let dx = b.x - a.x, dy = b.y - a.y, d2 = dx * dx + dy * dy;
    if (d2 > CELL * CELL) return;
    if (d2 < 1) { dx = Math.random() - 0.5; dy = Math.random() - 0.5; d2 = 1; }
    const f = (alpha * 500) / d2;
    a.vx -= dx * f; a.vy -= dy * f; b.vx += dx * f; b.vy += dy * f;
  };
  for (const { cx, cy, ns } of grid.values()) {
    for (let i = 0; i < ns.length; i++) for (let j = i + 1; j < ns.length; j++) push(ns[i], ns[j]);
    // each pair of neighboring cells once: right, and the three below
    for (const [ox, oy] of [[1, 0], [-1, 1], [0, 1], [1, 1]]) {
      const other = grid.get(`${cx + ox},${cy + oy}`);
      if (other) for (const a of ns) for (const b of other.ns) push(a, b);
    }
  }
  for (const l of g.links) {
    const dx = l.t.x - l.s.x, dy = l.t.y - l.s.y, d = Math.sqrt(dx * dx + dy * dy) || 1;
    const k = l.conn.key, len = l.conn.values ? 30 : k === "cites" ? 70 : 60;
    const f = ((d - len) / d) * alpha * (l.conn.values ? 0.5 : k === "cites" ? 0.3 : 0.25 * l.w * 3);
    const ws = l.t.deg / (l.s.deg + l.t.deg); // the lighter end moves more
    l.s.vx += dx * f * ws; l.s.vy += dy * f * ws; l.t.vx -= dx * f * (1 - ws); l.t.vy -= dy * f * (1 - ws);
  }
  for (const n of g.nodes) {
    n.vx -= n.x * 0.015 * alpha; n.vy -= n.y * 0.015 * alpha;
    if (n.fixed) { n.vx = n.vy = 0; continue; }
    n.vx *= 0.6; n.vy *= 0.6;
    n.x += n.vx; n.y += n.vy;
  }
}

// --- View ----------------------------------------------------------------------------------------
export async function viewGraph(main, { books, lib, esc, fold, load, save, openAuthor, byline, wantButton }) {
  const opts = load(STATE, {});
  if (!Array.isArray(opts.connect)) Object.assign(opts, { show: opts.show || "all", connect: ["author", "tags", "cites"], lonely: false });
  main.classList.add("wide");
  main.innerHTML = `
    <div class="toolbar">
      <input id="gq" type="search" placeholder="Find in graph" autocomplete="off">
      <div class="seg" role="group" aria-label="Books">
        ${[["all", "All books"], ["annotated", "Annotated"], ["want", "Want to read"]].map(([k, l]) => `<button data-show="${k}" aria-pressed="${opts.show === k}">${l}</button>`).join("")}
      </div>
      <div class="seg"><button id="lonely" aria-pressed="${opts.lonely === false}" title="Hide books with no connection">Only connected</button></div>
    </div>
    <div class="connect" role="group" aria-label="Connect by">
      <span class="lbl">Connect by</span>
      ${CONNECT.map((c) => `<button data-conn="${c.key}" aria-pressed="${opts.connect.includes(c.key)}"><span class="dot" style="background:var(--${c.color})"></span>${c.label}</button>`).join("")}
    </div>
    <p class="count" id="count">Building the graph…</p>
    <div class="graph" id="wrap">
      <canvas id="cv" aria-label="Graph of books and what connects them"></canvas>
      <div class="legend"><span class="dot dot-book"></span>book <span class="dot dot-unread"></span>not read yet <span class="dot dot-want"></span>want to read · small dots: shared values · arrows: citations</div>
      <button class="ghost fit" id="fit" title="Fit to screen">Fit</button>
      <aside class="card" id="card" hidden></aside>
    </div>`;
  const wrap = main.querySelector("#wrap"), cv = main.querySelector("#cv"), card = main.querySelector("#card");
  const ctx = cv.getContext("2d");

  // shared words and citations are loaded the first time they are switched on
  const data = { related: new Map(), cites: null };
  let vs = null, wordRows = 0;
  async function ensureData() {
    if (opts.connect.includes("words") && !vs) {
      let rows = [];
      try { rows = await lib.search(); } catch { /* offline without search.json: titles only */ }
      wordRows = rows.length;
      vs = vectors(books, rows, fold);
      data.related = relatedPairs(vs);
    }
    if (opts.connect.includes("cites") && !data.cites) data.cites = (await lib.citations()) || { links: [], missing: true };
  }

  let g, alpha = 1, view = { k: 1, x: 0, y: 0 }, W = 0, H = 0;
  let hover = null, selected = null, query = [];
  let colors = {}, hud = false; // hud: the HUD style (css/hud.css) draws square hubs, a crosshair and readouts
  const readColors = () => {
    const css = getComputedStyle(document.documentElement);
    for (const k of ["bg", "text", "muted", "border", "accent", "node-unread", "surface", ...CONNECT.map((c) => c.color)]) colors[k] = css.getPropertyValue("--" + k).trim();
    hud = document.documentElement.dataset.style === "hud";
  };
  readColors();

  const rebuild = async () => {
    save(STATE, opts);
    await ensureData();
    if (!cv.isConnected) return;
    g = buildGraph(books, data, opts, g?.byId);
    if (selected) selected = g.byId.get(selected.id) || null;
    const nb = g.nodes.filter((n) => n.kind === "book").length;
    const notes = [];
    if (CONNECT.some((c) => c.tag && opts.connect.includes(c.key))) notes.push(`${books.filter((b) => b.meta).length} of ${books.length} books tagged`);
    if (opts.connect.includes("cites")) notes.push(data.cites.missing ? "no citations yet (tools/citations.py)" : `citations from ${data.cites.scanned.length} scanned books`);
    if (opts.connect.includes("words") && !wordRows) notes.push("shared words: titles only (search.json offline?)");
    main.querySelector("#count").textContent = [`${nb} books · ${g.nodes.length - nb} shared values · ${g.links.length} links`, ...notes].join(" · ");
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
  /** Lit nodes: the focus, its neighbors, and for a book also the books it shares a hub with. */
  const lit = () => {
    const focus = hover || selected;
    if (focus) {
      const s = new Set([focus.id, ...g.adj.get(focus.id)]);
      if (focus.kind === "book") for (const id of g.adj.get(focus.id)) if (g.byId.get(id).kind === "hub") for (const o of g.adj.get(id)) s.add(o);
      return s;
    }
    if (query.length) return new Set(g.nodes.filter((n) => query.every((w) => fold(n.label).includes(w))).map((n) => n.id));
    return null;
  };
  const arrow = (l) => {
    const dx = l.t.x - l.s.x, dy = l.t.y - l.s.y, d = Math.hypot(dx, dy) || 1, ux = dx / d, uy = dy / d;
    const tx = l.t.x - ux * (size(l.t) + 1 / view.k), ty = l.t.y - uy * (size(l.t) + 1 / view.k), a = 6 / view.k;
    ctx.beginPath(); ctx.moveTo(tx, ty);
    ctx.lineTo(tx - ux * a - uy * a * 0.5, ty - uy * a + ux * a * 0.5);
    ctx.lineTo(tx - ux * a + uy * a * 0.5, ty - uy * a - ux * a * 0.5);
    ctx.closePath(); ctx.fill();
  };
  /** HUD: hairlines through the selected node to the frame, corner brackets around it, coordinates as a readout. */
  function hudFocus(n) {
    const sx = Math.round(view.x + n.x * view.k) + 0.5, sy = Math.round(view.y + n.y * view.k) + 0.5, r = size(n) * view.k + 7, c = 5;
    ctx.strokeStyle = ctx.fillStyle = colors.accent; ctx.lineWidth = 1;
    ctx.globalAlpha = 0.35;
    ctx.beginPath(); ctx.moveTo(0, sy); ctx.lineTo(sx - r - 4, sy); ctx.moveTo(sx + r + 4, sy); ctx.lineTo(W, sy);
    ctx.moveTo(sx, 0); ctx.lineTo(sx, sy - r - 4); ctx.moveTo(sx, sy + r + 4); ctx.lineTo(sx, H); ctx.stroke();
    ctx.globalAlpha = 1;
    ctx.beginPath();
    for (const [dx, dy] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
      ctx.moveTo(sx + dx * r, sy + dy * (r - c)); ctx.lineTo(sx + dx * r, sy + dy * r); ctx.lineTo(sx + dx * (r - c), sy + dy * r);
    }
    ctx.stroke();
    ctx.font = "500 10px 'IBM Plex Mono', ui-monospace, monospace"; ctx.textAlign = "left"; ctx.textBaseline = "bottom";
    const fmt = (v) => (v < 0 ? "-" : "+") + String(Math.abs(Math.round(v))).padStart(4, "0");
    ctx.fillText(`X ${fmt(n.x)}  Y ${fmt(-n.y)}  /  LINKS ${String(g.adj.get(n.id).size).padStart(2, "0")}`, sx + r + 6, sy - 4);
  }
  /** HUD: counts and zoom as corner readouts. */
  function hudReadout() {
    const nb = g.nodes.filter((n) => n.kind === "book").length;
    ctx.globalAlpha = 1; ctx.fillStyle = colors.muted; ctx.textBaseline = "top";
    ctx.font = "500 10px 'IBM Plex Mono', ui-monospace, monospace";
    ctx.textAlign = "left"; ctx.fillText(`BOOKS ${nb}  /  VALUES ${g.nodes.length - nb}  /  LINKS ${g.links.length}`, 14, 12);
    ctx.textAlign = "right"; ctx.fillText(`Z ${view.k.toFixed(2)}`, W - 14, 12);
  }
  function draw() {
    if (!g) return;
    ctx.clearRect(0, 0, W, H);
    ctx.save();
    ctx.translate(view.x, view.y);
    ctx.scale(view.k, view.k);
    const on = lit();
    ctx.lineWidth = 1 / view.k;
    for (const l of g.links) {
      const hot = on && on.has(l.s.id) && on.has(l.t.id);
      const key = l.conn.key;
      ctx.globalAlpha = on ? (hot ? 0.9 : 0.05) : key === "cites" ? 0.6 : key === "words" ? 0.35 : 0.3;
      ctx.strokeStyle = ctx.fillStyle = colors[l.conn.color];
      ctx.setLineDash(key === "words" ? [4 / view.k, 3 / view.k] : []);
      ctx.beginPath(); ctx.moveTo(l.s.x, l.s.y); ctx.lineTo(l.t.x, l.t.y); ctx.stroke();
      if (key === "cites") arrow(l);
    }
    ctx.setLineDash([]);
    for (const n of g.nodes) {
      ctx.globalAlpha = on && !on.has(n.id) ? 0.15 : 1;
      if (hud && n.kind === "hub") { // hollow square marker, like the HUD's target boxes
        const s = size(n) * 1.6;
        ctx.strokeStyle = colors[n.conn.color]; ctx.fillStyle = colors.bg;
        ctx.fillRect(n.x - s / 2, n.y - s / 2, s, s); ctx.strokeRect(n.x - s / 2, n.y - s / 2, s, s);
        continue;
      }
      ctx.fillStyle = n.kind === "hub" ? colors[n.conn.color] : n.book.read ? (hud ? colors.text : colors.accent) : colors["node-unread"];
      ctx.beginPath(); ctx.arc(n.x, n.y, size(n), 0, Math.PI * 2); ctx.fill();
      if (n.book?.want) { // want to read: a ring around the dot
        ctx.strokeStyle = colors.text; ctx.lineWidth = 1.5 / view.k;
        ctx.beginPath(); ctx.arc(n.x, n.y, size(n) + 2.5 / view.k, 0, Math.PI * 2); ctx.stroke();
        ctx.lineWidth = 1 / view.k;
      }
      if (n === selected && !hud) { ctx.strokeStyle = colors.text; ctx.lineWidth = 2 / view.k; ctx.stroke(); ctx.lineWidth = 1 / view.k; }
    }
    ctx.restore();
    if (hud) hudReadout();
    // labels in screen space, so they stay readable at any zoom
    ctx.globalAlpha = 1;
    ctx.textAlign = "center";
    ctx.textBaseline = "top";
    // the focused node first, then hubs by size (they name the clusters), then the biggest books;
    // a label that would overlap one already drawn is skipped
    const focus = hover || selected, boxes = [];
    const weight = (n) => n.kind === "hub" ? 100 + n.books.length : n.r;
    const order = g.nodes.filter((n) => on ? on.has(n.id)
      : n.kind === "hub" ? n.books.length >= 3 || view.k > 1.5 : n.r * view.k > 9 || (view.k > 2.2 && n.r * view.k > 5))
      .sort((a, b) => (b === focus) - (a === focus) || weight(b) - weight(a));
    for (const n of order) {
      const x = view.x + n.x * view.k, y = view.y + (n.y + size(n)) * view.k + 3;
      if (x < -100 || x > W + 100 || y < -20 || y > H + 20) continue;
      const hub = n.kind === "hub";
      ctx.font = hud ? (hub ? "500 10px 'IBM Plex Mono', ui-monospace, monospace" : "11px 'IBM Plex Sans', system-ui, sans-serif")
        : `${hub ? "600 11px" : "12px"} system-ui, -apple-system, 'Segoe UI', sans-serif`;
      let t = n.label.length > 42 ? n.label.slice(0, 40) + "…" : n.label;
      if (hud && hub) t = `${n.conn.code} / ${t.toUpperCase()}`;
      const w = ctx.measureText(t).width, box = [x - w / 2 - 2, y, x + w / 2 + 2, y + 15];
      if (boxes.some((o) => box[0] < o[2] && box[2] > o[0] && box[1] < o[3] && box[3] > o[1])) continue;
      boxes.push(box);
      ctx.lineWidth = 3; ctx.strokeStyle = colors.bg; ctx.strokeText(t, x, y);
      ctx.fillStyle = n === hover || n === selected ? colors.text : hub ? colors[n.conn.color] : colors.muted;
      ctx.fillText(t, x, y);
    }
    if (hud && selected) hudFocus(selected);
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
  /** Books related to book node n, each with the reasons (shared values, words, citations), most reasons first. */
  function relatedBooks(n) {
    const why = new Map();
    const add = (m, r) => (why.get(m) || why.set(m, []).get(m)).push(r);
    for (const id of g.adj.get(n.id)) {
      const h = g.byId.get(id);
      if (h.kind === "hub") for (const b of h.books) { const m = g.byId.get(b.id); if (m && m !== n) add(m, `${h.conn.label.toLowerCase()}: ${h.label}`); }
    }
    for (const l of g.links) {
      if (l.s !== n && l.t !== n) continue;
      const m = l.s === n ? l.t : l.s;
      if (l.conn.key === "words") add(m, `words: ${sharedWords(vs, n.id, m.id, 3).join(", ")}`);
      if (l.conn.key === "cites") add(m, l.s === n ? "cited in this book" : "cites this book");
    }
    return [...why].sort((a, b) => b[1].length - a[1].length || a[0].label.localeCompare(b[0].label));
  }
  function showCard() {
    const n = selected;
    card.hidden = !n;
    if (!n) return;
    const item = (m, why) => `<li><button class="link" data-sel="${esc(m.id)}">${esc(m.label)}</button>${why ? ` <span class="muted">${esc(why)}</span>` : ""}</li>`;
    if (n.kind === "hub") {
      const c = n.conn;
      card.innerHTML = `<button class="close" id="cx" aria-label="Close">×</button>
        <h2>${esc(n.label)}</h2>
        <p class="meta"><span class="dot" style="background:var(--${c.color})"></span> ${esc(c.label)} · ${n.books.length} books</p>
        <ul>${n.books.map((b) => g.byId.get(b.id)).filter(Boolean).map((m) => item(m)).join("")}</ul>
        ${c.key === "author" || c.tag ? `<button class="ghost" id="lib">Show in library</button>` : ""}`;
      const btn = card.querySelector("#lib");
      if (btn) btn.onclick = () => c.key === "author" ? openAuthor(n.label) : location.hash = `#/tag/${c.key}/${encodeURIComponent(n.label)}`;
    } else {
      const b = n.book;
      const hubs = [...g.adj.get(n.id)].map((id) => g.byId.get(id)).filter((m) => m.kind === "hub");
      const rel = relatedBooks(n);
      const cited = (data.cites?.links || []).filter((c) => c.from === b.id || c.to === b.id);
      card.innerHTML = `<button class="close" id="cx" aria-label="Close">×</button>
        <h2><a href="#/book/${esc(b.id)}">${esc(b.title)}</a></h2>
        <p class="meta">${esc(byline(b))}
          · ${b.annotations ? `${b.annotations} annotations` : b.read ? "no annotations" : "not read yet"}</p>
        <p class="actions">${wantButton(b)}</p>
        ${hubs.length ? `<h3>Connected through</h3><p class="hubs">${hubs.map((h) =>
          `<button class="chip" data-sel="${esc(h.id)}"><span class="dot" style="background:var(--${h.conn.color})"></span>${esc(h.label)}</button>`).join("")}</p>` : ""}
        ${rel.length ? `<h3>Related books (${rel.length})</h3><ul>${rel.slice(0, 40).map(([m, why]) => item(m, why.join(" · "))).join("")}</ul>
          ${rel.length > 40 ? `<p class="meta">+ ${rel.length - 40} more</p>` : ""}` : `<p class="meta">No connections with the current “Connect by”.</p>`}
        ${opts.connect.includes("cites") && cited.length ? `<h3>Citation context</h3>${cited.slice(0, 6).map((c) =>
          `<p class="ctx"><b>${esc(g.byId.get(c.from)?.label || "")}</b> → ${esc(g.byId.get(c.to)?.label || "")}<br>“…${esc(c.ctx)}…”</p>`).join("")}` : ""}
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
    if (!g) return;
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
    if (!g) return;
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
    const n = g && hit(e);
    if (n?.kind === "book") location.hash = `#/book/${n.id}`;
    else if (n?.conn.key === "author") openAuthor(n.label);
    else if (n?.conn.tag) location.hash = `#/tag/${n.conn.key}/${encodeURIComponent(n.label)}`;
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
  main.querySelector("#lonely").addEventListener("click", (e) => {
    opts.lonely = opts.lonely === false;
    e.currentTarget.setAttribute("aria-pressed", opts.lonely === false);
    rebuild();
  });
  main.querySelectorAll("[data-conn]").forEach((btn) => btn.addEventListener("click", () => {
    const k = btn.dataset.conn;
    opts.connect = opts.connect.includes(k) ? opts.connect.filter((x) => x !== k) : [...opts.connect, k];
    btn.setAttribute("aria-pressed", opts.connect.includes(k));
    rebuild();
  }));
  main.querySelector("#fit").addEventListener("click", () => { fit(); draw(); });

  const ro = new ResizeObserver(resize);
  ro.observe(wrap);
  const onTheme = () => { readColors(); draw(); };
  addEventListener("themechange", onTheme);
  const onWant = () => opts.show === "want" ? rebuild() : draw(); // marked in the card: redraw the ring
  document.addEventListener("want", onWant);
  function cleanup() { cancelAnimationFrame(frame); ro.disconnect(); removeEventListener("themechange", onTheme); document.removeEventListener("want", onWant); }
  main.dispose = cleanup;

  const r = wrap.getBoundingClientRect();
  W = r.width; H = r.height;
  rebuild();
}
