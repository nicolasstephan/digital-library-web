// Timeline view: books in order of publication on a one-dimensional grid. Every book is one cell of the same
// width, so a year is as wide as the books it holds: busy years stretch out, empty years take no room at all.
// Books are spines (title upright, author below) with a yellow bar at the foot that grows with the highlight count.
// "Spines" colors them by one attribute: project or collection (one hue per value), how often other books in the
// library cite it, or how recently it was added (one hue, stronger = more). Rows under the axis ("tracks", like a
// genome browser) show several attributes at once, one cell per book, aligned with its spine.
// Filters drop books from the grid (the years close up); the text filter only dims what doesn't match.
// Books on the want-to-read list carry a notch at the top of the spine (and an optional "Want" row).
// Hovering a spine shows the book in a card under the timeline; a click pins the card with all its notes.
// The PDF viewer beside the card (pdfview.js) shows the pinned book; clicking a note goes to its page there.

import { pdfViewer } from "./pdfview.js";

const STATE = "dl.timelineView";
const SIZES = [["s", "Narrow", 14], ["m", "Medium", 26], ["l", "Wide", 46]];
// primary colors (tokens --tl-*): yellow is the highlight bar, red "cited", green "added"; categories take blue first
const PRIMARY = ["--tl-blue", "--tl-red", "--tl-green", "--tl-yellow"];
const HUES = { project: PRIMARY, collection: PRIMARY };
const COLL = { Proceedings: "Proceedings", Collections: "Collections", Add: "Add", "00_Inbox": "Inbox" };
const SCHEMES = [
  { key: "highlights", label: "Highlights only", short: "Highlights" },
  { key: "project", label: "Project", short: "Project", cat: (b) => [].concat(b.meta?.project ?? [])[0] },
  { key: "collection", label: "Collection", short: "Collection", cat: (b) => b.collection && b.collection !== "Authors" ? COLL[b.collection] || b.collection : null },
  { key: "cited", label: "Cited in library", short: "Cited", hue: "--tl-red" },
  { key: "added", label: "Recently added", short: "Added", hue: "--tl-green" },
  { key: "want", label: "Want to read", short: "Want", hue: "--text", row: true }, // a row only: the notch marks the spines
];
const ROWS = ["project", "collection", "cited", "added", "want"];
const CITED = [[1, .35, "1×"], [2, .6, "2×"], [4, .8, "3–4×"], [Infinity, 1, "5×+"]]; // times cited → strength
const ADDED = [[30, 1, "30 days"], [91, .6, "3 months"], [365, .3, "year"]]; // days since added → strength

const lastName = (b) => (b.authors || [])[0] || "";

export function viewTimeline(main, ctx) {
  const { books, lib, esc, fold, load, save, byline, tagOptions, hasTag, chipsHtml, annotationHtml, loadImages, isMine, wantButton } = ctx;
  main.classList.add("wide");
  const v = { show: "all", tag: "", size: "m", undated: false, q: "", scroll: 0, color: "project", rows: ROWS.filter((k) => k !== "want"), ...load(STATE, {}) };
  if (!load(STATE, {}).rows) v.color = "project"; // saved before the rows existed: start with colored spines
  main.innerHTML = `
    <div class="toolbar">
      <input id="tlq" type="search" placeholder="Highlight by title, author or tag" value="${esc(v.q)}" autocomplete="off">
      <div class="seg" role="group" aria-label="Show">
        ${[["all", "All"], ["annotated", "Annotated"], ["tagged", "Summarized"], ["want", "Want to read"]].map(([k, l]) =>
          `<button data-show="${k}" aria-pressed="${v.show === k}">${l}</button>`).join("")}
      </div>
      <select id="tltag" aria-label="Tag"><option value="">All tags</option>${tagOptions(v.tag)}</select>
      <select id="tlcolor" aria-label="Color by">${SCHEMES.filter((x) => !x.row).map(({ key, label }) =>
        `<option value="${key}" ${v.color === key ? "selected" : ""}>Spines: ${label}</option>`).join("")}</select>
      <div class="seg" role="group" aria-label="Rows under the timeline">
        ${ROWS.map((k) => `<button data-row="${k}" aria-pressed="${v.rows.includes(k)}">${SCHEMES.find((s) => s.key === k).short}</button>`).join("")}
      </div>
      <div class="seg" role="group" aria-label="Book width">
        ${SIZES.map(([k, l]) => `<button data-size="${k}" aria-pressed="${v.size === k}">${l}</button>`).join("")}
      </div>
      <div class="seg" role="group" aria-label="Spine shape">
        <button data-angle="0" aria-pressed="${!v.angle}" title="Titles upright along the spines">Upright</button><button data-angle="1" aria-pressed="${!!v.angle}" title="The spines turn 45° above the highlight bars, titles run along them (test)">45°</button>
      </div>
      <label class="check"><input type="checkbox" id="tlundated" ${v.undated ? "checked" : ""}> books without a year</label>
    </div>
    <p class="count" id="tlinfo"></p>
    <div class="timeline" id="tl"><div class="tl-track" id="track"></div><div class="tl-labels" id="tllabels"></div>
      <button type="button" class="tl-nav prev" id="tlprev" aria-label="Earlier">‹</button><button type="button" class="tl-nav next" id="tlnext" aria-label="Later">›</button></div>
    <div class="tl-pos" id="tlpos" title="Click to jump"><i></i></div>
    <p class="tl-legend" id="tllegend"></p>
    <div class="tl-below with-pdf" id="tlbelow"><section class="tl-card" id="tlcard"></section><section class="pv" id="pv"></section></div>`;

  const tl = main.querySelector("#tl"), track = main.querySelector("#track"), info = main.querySelector("#tlinfo");
  const labelsEl = main.querySelector("#tllabels"), posbar = main.querySelector("#tlpos");
  const card = main.querySelector("#tlcard"), legend = main.querySelector("#tllegend"), below = main.querySelector("#tlbelow");
  // a new highlight from the viewer: list it with the notes at once (the extractor's version follows)
  const viewer = pdfViewer(main.querySelector("#pv"), { esc, onHighlight: (b, a) => {
    const list = notes.get(b.id);
    if (list) { list.push(a); list.sort((x, y) => x.page - y.page || (x.rect?.[1] ?? 0) - (y.rect?.[1] ?? 0)); }
    b.annotations = (b.annotations || 0) + 1;
    if (pinned === b) { inCard = undefined; showCard(b); }
  } });
  let shown = [], summary = "", cites = null;

  /** One attribute as colors: id → [hue variable, strength 0..1], plus its legend. */
  const scale = (key) => {
    const s = SCHEMES.find((x) => x.key === key);
    const val = new Map();
    const sw = (h, x = 1) => `<span class="sw" style="background: ${mix(h, x * 100)}"></span>`;
    if (s.cat) { // one hue per value, the most frequent values first; the rest stay gray
      const counts = new Map();
      for (const b of shown) { const c = s.cat(b); if (c) counts.set(c, (counts.get(c) || 0) + 1); }
      const ranked = [...counts].sort((a, b) => b[1] - a[1]);
      const hue = new Map(ranked.slice(0, HUES[key].length).map(([c], i) => [c, HUES[key][i]]));
      for (const b of shown) { const h = hue.get(s.cat(b)); if (h) val.set(b.id, [h, 1]); }
      const none = shown.length - ranked.reduce((t, [, n]) => t + n, 0);
      const parts = ranked.map(([c, n]) => `${hue.get(c) ? sw(hue.get(c)) : `<span class="sw"></span>`}${esc(c)} ${n}`);
      parts.push(`<span class="sw"></span>${key === "project" ? "no project tag" : "Authors folder"} ${none}`);
      return { val, legend: parts.join(" · ") + (key === "project" ? ` <span class="muted">(project tags exist for ${books.filter((b) => s.cat(b)).length} books so far)</span>` : "") };
    }
    if (key === "cited") { // times cited by other books here, in steps
      if (!cites) return { val, legend: "loading citations…" };
      const n = new Map();
      for (const l of cites.links || []) if (l.from !== l.to) n.set(l.to, (n.get(l.to) || 0) + 1);
      for (const b of shown) if (n.get(b.id)) val.set(b.id, [s.hue, CITED.find(([max]) => n.get(b.id) <= max)[1]]);
      return { val, legend: cites.missing ? "no citations yet (tools/citations.py)"
        : `${CITED.map(([, x, l]) => `${sw(s.hue, x)}${l}`).join(" ")} · ${val.size} of ${shown.length} books cited by others here (from ${cites.scanned?.length ?? "?"} scanned books)` };
    }
    if (key === "want") {
      for (const b of shown) if (b.want) val.set(b.id, [s.hue, 1]);
      return { val, legend: `${sw(s.hue)}on the want-to-read list · ${val.size} of ${shown.length} books` };
    }
    // added: the last 30 days strongest, then the last 3 months, the last year
    const now = Date.now();
    for (const b of shown) {
      const step = b.added && ADDED.find(([max]) => (now - Date.parse(b.added)) / 864e5 <= max);
      if (step) val.set(b.id, [s.hue, step[1]]);
    }
    return { val, legend: `in the last ${ADDED.map(([, x, l]) => `${sw(s.hue, x)}${l}`).join(" ")} · ${val.size} of ${shown.length} books` };
  };
  const mix = (h, pct) => pct >= 100 ? `var(${h})` : `color-mix(in srgb, var(${h}) ${Math.round(pct)}%, var(--bg))`;

  /** Spine fills, the rows under the axis and the legend for both. */
  const coloring = () => {
    const fill = new Map();
    const n = shown.filter((b) => b.annotations).length;
    const lines = [`<span class="sw sw-mark"></span>highlights and notes: the bar at the foot grows with the count · ${n} of ${shown.length} books annotated`];
    const w = shown.filter((b) => b.want).length;
    if (w) lines.push(`<span class="sw sw-want"></span>notch at the top: want to read · ${w} books`);
    if (v.color !== "highlights") {
      const { val, legend } = scale(v.color);
      // full strength: the text color made for that hue (--tl-blue-on …); lighter steps keep the normal text
      for (const [id, [h, x]] of val) fill.set(id, `background: ${mix(h, x * 100)}${x >= 1 ? `; color: var(${h}-on)` : ""}`);
      lines.push(`<b>Spines</b> ${v.rows.includes(v.color) ? `colored like the ${SCHEMES.find((s) => s.key === v.color).short} row` : legend}`);
    }
    const rows = ROWS.filter((k) => v.rows.includes(k)).map((k) => {
      const { val, legend } = scale(k);
      lines.push(`<b>${SCHEMES.find((s) => s.key === k).short}</b> ${legend}`);
      return { key: k, val };
    });
    legend.innerHTML = lines.map((l) => `<span class="line">${l}</span>`).join("");
    return { fill, rows };
  };

  // --- layout and paging. The whole timeline is laid out as numbers (x of every year and book), but only the books
  // around the current position are in the page: the screen in view plus two screens to each side. The arrows,
  // ←/→ keys, the wheel and swipes move one screen at a time; after a move the screens around the new place are
  // drawn in the background, so the next move needs no work. Works the same for 300 or 30 000 books.
  let layout = null; // { years: [{ year, books, x, w, dec, decLabel, gap }], width, cell, rows, fill, xOf: Map id → x }
  let pos = 0, win = null; // pos: left edge of the view (px); win: [from, to] drawn range (px)
  let hitSet = null, hitInfo = ""; // text filter: ids that match (null = no filter)
  let viewPx = 0; // width of the view inside the side padding; measured on draw and resize, not while paging (a layout read costs 100 ms+)
  const viewW = () => viewPx || (viewPx = Math.max(200, tl.clientWidth - 32));
  let leanPx = 0; // 45°: how far the titles reach to the right (spines height minus the foot); measured once per draw, never while paging
  const measureLean = () => { leanPx = v.angle ? Math.max(0, (track.querySelector(".tl-books")?.offsetHeight || 320) - 28) : 0; };
  const lean = () => leanPx;
  const maxPos = () => layout ? Math.max(0, layout.width + lean() - viewW()) : 0;
  const step = () => Math.max(layout.cell, Math.floor(viewW() * 0.85 / layout.cell) * layout.cell); // keep a little of the last screen
  const yearAt = (x) => layout?.years.find((y) => y.x + y.w > x) || layout?.years.at(-1);

  const yearHtml = (y) => {
    const { rows, fill } = layout;
    const off = (b) => hitSet && !hitSet.has(b.id);
    return `<div class="tl-year${y.dec ? " dec" : ""}${y.gap ? " gap" : ""}${y.w < 38 ? " narrow" : ""}${y.year ? "" : " nd"}"
        style="width:${y.w}px" ${y.gap ? `title="${y.gap} year${y.gap > 1 ? "s" : ""} without books before ${y.year}"` : ""}>
      ${y.decLabel ? `<span class="tl-dec">${y.decade}s</span>` : ""}
      <div class="tl-books">${y.books.map((b) => {
        const hl = b.annotations ? Math.round(Math.min(90, 3 + Math.sqrt(b.annotations) * 4)) : 0; // px
        return `<a class="tl-book${b.read ? "" : " unread"}${b.want ? " want" : ""}${b === pinned ? " sel" : ""}${off(b) ? " off" : ""}" href="#/book/${b.id}" data-id="${b.id}" style="--hl:${hl}px;${fill.get(b.id) || ""}">
          ${v.angle // 45°: the spine's upper part as a slanted band, the title along it (author after it when wide)
            ? `<span class="band"></span><span class="t">${esc(b.title)}${v.size !== "s" && lastName(b) ? ` <span class="a">${esc(lastName(b))}</span>` : ""}</span>`
            : `<span class="t">${esc(b.title)}</span>${v.size === "l" && lastName(b) ? `<span class="a">${esc(lastName(b))}</span>` : ""}`}</a>`;
      }).join("")}</div>
      ${rows.length ? `<div class="tl-rows">${rows.map(({ val }) => `<div class="tl-row">${y.books.map((b) => {
        const c = val.get(b.id);
        return `<i data-id="${b.id}"${off(b) ? ` class="off"` : ""}${c ? ` style="background: ${mix(c[0], c[1] * 100)}"` : ""}></i>`;
      }).join("")}</div>`).join("")}</div>` : ""}
      <span class="tl-y">${y.year ?? "no year"}</span>
    </div>`;
  };

  /** Puts the years around pos into the page; a spacer stands in for everything before them. */
  const drawWindow = () => {
    if (!layout.years.length) { track.innerHTML = `<p class="empty">No books match.</p>`; win = [0, 0]; return; }
    const W = viewW(), from = pos - 2 * W - lean(), to = pos + 3 * W;
    let ys = layout.years.filter((y) => y.x + y.w > from && y.x < to);
    if (!ys.length) ys = [yearAt(pos)];
    win = [ys[0].x, ys.at(-1).x + ys.at(-1).w];
    track.innerHTML = `<div class="tl-spacer" style="width:${ys[0].x - (ys[0].year ? 0 : 24)}px"></div>` + ys.map(yearHtml).join("");
  };
  /** Moves the view to x (px), sliding when it is near; draws first only if the target isn't in the page yet. */
  const go = (x, animate = true) => {
    if (!layout) return;
    const W = viewW(), target = Math.round(Math.min(maxPos(), Math.max(0, x)));
    const near = Math.abs(target - pos) <= 1.2 * W;
    pos = target;
    if (!win || win[0] > Math.max(0, pos - lean()) || win[1] < Math.min(layout.width, pos + W)) drawWindow();
    track.style.transition = animate && near ? "transform .32s ease" : "none";
    track.style.transform = `translateX(${-pos}px)`;
    v.scroll = maxPos() ? pos / maxPos() : 0;
    save(STATE, v);
    nav();
    clearTimeout(go.t); // afterwards: draw the screens around the new place, so the next move is instant
    go.t = setTimeout(() => {
      if (layout && (win[0] > Math.max(0, pos - 1.5 * W - lean()) || win[1] < Math.min(layout.width, pos + 2.5 * W))) drawWindow();
    }, 380);
  };
  const range = (x) => {
    const a = yearAt(x), b = yearAt(x + viewW() - 1);
    return a ? `${a.year ?? "no year"}${b && b !== a ? `–${b.year ?? "no year"}` : ""}` : "";
  };
  const nav = () => {
    const W = viewW(), m = maxPos(), prev = main.querySelector("#tlprev"), next = main.querySelector("#tlnext");
    prev.disabled = pos <= 0; next.disabled = pos >= m;
    prev.title = pos > 0 ? `← ${range(Math.max(0, pos - step()))}` : "";
    next.title = pos < m ? `${range(Math.min(m, pos + step()))} →` : "";
    const total = layout.width + lean() || 1;
    Object.assign(posbar.querySelector("i").style, { left: `${pos / total * 100}%`, width: `${Math.min(1, W / total) * 100}%` });
    posbar.hidden = m <= 0;
    info.textContent = `${hitInfo || summary}${layout.years.length ? ` · showing ${range(pos)}` : ""}`;
  };

  const render = () => {
    save(STATE, v);
    if ((v.color === "cited" || v.rows.includes("cited")) && !cites) lib.citations().then((c) => { cites = c || { links: [], missing: true }; render(); });
    const pass = (b) => (v.show !== "annotated" || b.annotations) && (v.show !== "tagged" || b.meta) && (v.show !== "want" || b.want) && (!v.tag || hasTag(b, v.tag));
    const dated = books.filter((b) => b.year && pass(b));
    const undated = books.filter((b) => !b.year && pass(b));
    dated.sort((a, b) => a.year - b.year || fold(lastName(a) || a.title).localeCompare(fold(lastName(b) || b.title)));
    undated.sort((a, b) => fold(lastName(a) || a.title).localeCompare(fold(lastName(b) || b.title)));

    // one column per year (only years that have books), in grid order
    const years = [];
    for (const b of dated) (years.at(-1)?.year === b.year ? years.at(-1) : years[years.push({ year: b.year, books: [] }) - 1]).books.push(b);
    if (v.undated && undated.length) years.push({ year: null, books: undated });
    shown = years.flatMap((y) => y.books);
    const { fill, rows } = coloring();

    const keep = layout && yearAt(pos); // stay at the same year when filters, width or shape change
    const cell = SIZES.find(([k]) => k === v.size)[2];
    track.style.setProperty("--cell", `${cell}px`);
    track.dataset.size = v.size;
    track.classList.toggle("angled", !!v.angle);
    // decade labels only where the decade is wide enough for one (thin early decades share the axis)
    const decadeWidth = new Map();
    for (const y of years) if (y.year) { const d = Math.floor(y.year / 10) * 10; decadeWidth.set(d, (decadeWidth.get(d) || 0) + y.books.length * cell); }
    let prevDecade = null, prevYear = null, x = 0;
    const xOf = new Map();
    for (const y of years) {
      y.decade = y.year && Math.floor(y.year / 10) * 10;
      y.dec = y.year && y.decade !== prevDecade;
      y.decLabel = y.dec && decadeWidth.get(y.decade) >= 44;
      y.gap = y.year && prevYear && y.year - prevYear > 1 ? y.year - prevYear - 1 : 0; // skipped years, shown as a mark
      prevDecade = y.decade; prevYear = y.year;
      if (!y.year) x += 24; // the "no year" block keeps a little distance
      y.x = x; y.w = y.books.length * cell;
      y.books.forEach((b, i) => xOf.set(b.id, x + i * cell));
      x += y.w;
    }
    layout = { years, width: x, cell, rows, fill, xOf };
    labelsEl.innerHTML = rows.map((r) => `<span>${SCHEMES.find((s) => s.key === r.key).short}</span>`).join("");
    labelsEl.hidden = !rows.length || !years.length;

    const span = dated.length ? `${dated[0].year}–${dated.at(-1).year}` : "";
    summary = `${shown.length} books${span ? ` · ${span}` : ""} · ${years.filter((y) => y.year).length} years with books` +
      (undated.length && !v.undated ? ` · ${undated.length} without a year not shown` : "");
    matchSet();
    win = null;
    const at = keep ? (years.find((y) => y.year === keep.year || (keep.year && y.year > keep.year))?.x ?? x) : null;
    pos = 0;
    leanPx = 0;
    go(at ?? 0, false); // draws the window
    measureLean(); // the 45° reach is known once something is drawn
    if (at == null && v.scroll) go(v.scroll * maxPos(), false); // first draw: back to the saved place
    pin(pinned && shown.includes(pinned) ? pinned : null, false); // keep the pinned book if the filters still show it
  };

  // text filter: dim the books that don't match (keeps the grid as it is)
  const matchSet = () => {
    const words = fold(v.q).split(/\s+/).filter(Boolean);
    const tags = (b) => ["tags", "project", "paper", "use", "type", "place", "period", "people"].flatMap((f) => [].concat(b.meta?.[f] ?? [])).join(" ");
    hitSet = words.length ? new Set(shown.filter((b) => words.every((w) => fold(`${b.title} ${(b.names || b.authors || []).join(" ")} ${b.year || ""} ${tags(b)}`).includes(w))).map((b) => b.id)) : null;
    hitInfo = hitSet ? `${summary} · ${hitSet.size} match` : "";
  };
  const dim = () => {
    matchSet();
    track.querySelectorAll(".tl-book, .tl-row i").forEach((el) => el.classList.toggle("off", !!hitSet && !hitSet.has(el.dataset.id)));
    if (layout) nav();
  };

  // book card under the timeline: hovering previews a book, a click pins it with all its highlights and notes
  let pinned = null, inCard, othersToo = false;
  const notes = new Map(); // id → highlights, loaded once per book
  const showCard = (b) => {
    if (b === inCard) return;
    inCard = b;
    card.classList.toggle("pinned", !!b && pinned === b);
    if (!b) { card.innerHTML = `<p class="hint">Point at a book to see it here; click to keep it open with its notes.</p>`; return; }
    const facts = [b.collection && b.collection !== "Authors" ? b.collection : "", b.pages ? `${b.pages} pages` : "",
      b.annotations ? `${b.annotations} annotations` : b.read ? "no annotations" : "not read yet", b.added ? `added ${b.added}` : ""].filter(Boolean);
    card.innerHTML = `
      ${pinned === b ? `<button class="close" aria-label="Close" title="Close">×</button>` : ""}
      <h2>${esc(b.title)}</h2>
      <p class="meta">${esc(byline(b))}${facts.length ? ` · ${esc(facts.join(" · "))}` : ""}</p>
      ${pinned === b ? `<p class="actions">${wantButton(b)}</p>` : ""}
      ${b.meta?.summary ? `<p class="summary">${esc(b.meta.summary)}</p>` : ""}
      ${b.meta ? `<p class="chips">${chipsHtml(b, true)}</p>` : ""}
      ${pinned === b ? `<div class="tl-notes" id="tlnotes"></div><a class="open" href="#/book/${b.id}">Book page →</a>`
        : `<p class="hint">Click to keep this open${b.annotations ? " with its notes" : ""}</p>`}`;
    if (pinned === b) fillNotes(b);
  };
  const fillNotes = async (b) => {
    const box = card.querySelector("#tlnotes");
    if (!b.read) { box.innerHTML = `<p class="muted">Not read yet: the file is only in iCloud.</p>`; return; }
    if (!b.annotations) { box.innerHTML = `<p class="muted">No highlights or notes in this book yet.</p>`; return; }
    box.innerHTML = `<p class="muted">Loading notes…</p>`;
    let items;
    try { items = notes.get(b.id) || await lib.highlights(b.id); } catch (e) { box.innerHTML = `<p class="error">${esc(e.message)}</p>`; return; }
    notes.set(b.id, items);
    if (pinned !== b || !box.isConnected) return; // another book was picked meanwhile
    const foreign = items.filter((a) => !isMine(a)).length;
    const list = items.filter((a) => othersToo || isMine(a));
    let page = null, html = "";
    list.forEach((a, i) => {
      if (a.page !== page) { html += `${page !== null ? "</section>" : ""}<section class="page"><h2>p. ${a.page}</h2>`; page = a.page; }
      html += `<div class="tl-note${b.ext === "pdf" ? " go" : ""}" data-i="${i}" title="${b.ext === "pdf" ? "Show in the PDF" : ""}">${annotationHtml(a, [], b)}</div>`;
    });
    if (page !== null) html += "</section>";
    box.innerHTML = `<h3>${list.length} highlights and notes</h3>` +
      (foreign ? `<label class="check"><input type="checkbox" id="tlothers" ${othersToo ? "checked" : ""}> also ${foreign} by others</label>` : "") +
      (html || `<p class="muted">Only notes by others in this book.</p>`);
    loadImages(box);
    box.querySelector("#tlothers")?.addEventListener("change", (e) => { othersToo = e.target.checked; fillNotes(b); });
    box.addEventListener("click", (e) => { // a note: show it in the PDF
      const n = e.target.closest(".tl-note.go");
      if (!n || e.target.closest("details, a, input, button")) return;
      const a = list[+n.dataset.i];
      box.querySelectorAll(".tl-note.on").forEach((x) => x.classList.remove("on"));
      n.classList.add("on");
      viewer.show(b, a.page, a.rect);
    });  };
  const pin = (b, scroll = true) => {
    const changed = pinned !== b;
    pinned = b;
    track.querySelectorAll(".tl-book.sel").forEach((el) => el.classList.remove("sel"));
    if (b) track.querySelector(`.tl-book[data-id="${b.id}"]`)?.classList.add("sel");
    if (changed) { inCard = undefined; b ? viewer.show(b, 1) : viewer.clear(); } // pinned: draw it again with its notes
    showCard(b);
    if (b && changed && scroll && card.getBoundingClientRect().top > innerHeight - 120) card.scrollIntoView({ behavior: "smooth", block: "nearest" });
  };
  const bookAt = (e) => { const el = e.target.closest(".tl-book, .tl-row i"); return el && shown.find((x) => x.id === el.dataset.id); };
  track.addEventListener("pointerover", (e) => { const b = bookAt(e); if (b && e.pointerType !== "touch") showCard(b); });
  track.addEventListener("pointerleave", () => showCard(pinned));
  track.addEventListener("click", (e) => {
    const b = bookAt(e);
    if (!b || e.ctrlKey || e.metaKey || e.shiftKey) return; // modifier clicks still open the book in a new tab
    e.preventDefault();
    pin(pinned === b ? null : b); // a second click on the same book lets it go
  });
  card.addEventListener("click", (e) => {
    if (e.target.closest(".close")) pin(null);
  });
  const onKey = (e) => {
    if (e.key === "Escape") pin(null);
    if (e.target.closest?.("input, textarea, select, [contenteditable]") || e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.key === "ArrowRight" || e.key === "PageDown") { e.preventDefault(); go(pos + step()); }
    if (e.key === "ArrowLeft" || e.key === "PageUp") { e.preventDefault(); go(pos - step()); }
    if (e.key === "Home") go(0);
    if (e.key === "End") go(maxPos());
  };
  document.addEventListener("keydown", onKey);
  // marked or unmarked in the card: the filter or the "Want" row may change, else just the notch
  const onWant = (e) => {
    if (v.show === "want" || v.rows.includes("want")) render();
    else track.querySelector(`.tl-book[data-id="${e.detail.id}"]`)?.classList.toggle("want", !!e.detail.want);
  };
  document.addEventListener("want", onWant);
  const onResize = () => { viewPx = 0; if (layout) { win = null; go(pos, false); measureLean(); } };
  addEventListener("resize", onResize);
  main.dispose = () => { document.removeEventListener("keydown", onKey); document.removeEventListener("want", onWant); removeEventListener("resize", onResize); clearTimeout(go.t); viewer.dispose(); };

  // paging: arrows, the position bar, the wheel (one notch or flick = one screen) and horizontal swipes
  main.querySelector("#tlprev").addEventListener("click", () => go(pos - step()));
  main.querySelector("#tlnext").addEventListener("click", () => go(pos + step()));
  posbar.addEventListener("click", (e) => {
    const r = posbar.getBoundingClientRect();
    go((e.clientX - r.left) / r.width * (layout.width + lean()) - viewW() / 2);
  });
  let acc = 0, lock = 0;
  tl.addEventListener("wheel", (e) => {
    if (e.ctrlKey) return;
    e.preventDefault();
    if (Date.now() < lock) return;
    acc += Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
    if (Math.abs(acc) < 40) return;
    go(pos + Math.sign(acc) * step());
    acc = 0; lock = Date.now() + 420; // a trackpad flick sends many events: one screen per flick
  }, { passive: false });
  let swipe = null;
  tl.addEventListener("pointerdown", (e) => { if (e.pointerType !== "mouse") swipe = { x: e.clientX, y: e.clientY }; });
  tl.addEventListener("pointerup", (e) => {
    if (!swipe) return;
    const dx = e.clientX - swipe.x, dy = e.clientY - swipe.y;
    swipe = null;
    if (Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy) * 1.5) go(pos - Math.sign(dx) * step());
  });

  main.querySelector("#tlq").addEventListener("input", (e) => {
    v.q = e.target.value;
    save(STATE, v);
    dim();
    const first = hitSet && shown.find((b) => hitSet.has(b.id)); // bring the first match into view
    if (first) go(layout.xOf.get(first.id) - 40);
  });
  main.querySelectorAll("[data-show]").forEach((btn) => btn.addEventListener("click", () => {
    v.show = btn.dataset.show;
    main.querySelectorAll("[data-show]").forEach((b) => b.setAttribute("aria-pressed", b === btn));
    render();
  }));
  main.querySelectorAll("[data-size]").forEach((btn) => btn.addEventListener("click", () => {
    v.size = btn.dataset.size; // render keeps the same year in view
    main.querySelectorAll("[data-size]").forEach((b) => b.setAttribute("aria-pressed", b === btn));
    render();
  }));
  main.querySelectorAll("[data-row]").forEach((btn) => btn.addEventListener("click", () => {
    const k = btn.dataset.row;
    v.rows = v.rows.includes(k) ? v.rows.filter((x) => x !== k) : [...v.rows, k];
    btn.setAttribute("aria-pressed", v.rows.includes(k));
    render();
  }));
  main.querySelectorAll("[data-angle]").forEach((btn) => btn.addEventListener("click", () => {
    v.angle = btn.dataset.angle === "1";
    main.querySelectorAll("[data-angle]").forEach((b) => b.setAttribute("aria-pressed", b === btn));
    render();
  }));
  main.querySelector("#tltag").addEventListener("change", (e) => { v.tag = e.target.value; render(); });
  main.querySelector("#tlcolor").addEventListener("change", (e) => { v.color = e.target.value; render(); });
  main.querySelector("#tlundated").addEventListener("change", (e) => { v.undated = e.target.checked; render(); });

  render();
}
