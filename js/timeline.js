// Timeline view: books in order of publication on a one-dimensional grid. Every book is one cell of the same
// width, so a year is as wide as the books it holds: busy years stretch out, empty years take no room at all.
// Books are spines (title upright, author below). "Color by" picks what the spines show: highlights (yellow bar at
// the foot, grows with the count), project or collection (one hue per value), how often other books in the library
// cite it, or how recently it was added (one hue, darker = more).
// Filters drop books from the grid (the years close up); the text filter only dims what doesn't match.
// Hovering a spine shows the book in a card under the timeline; a click pins the card with all its notes.
// Clicking a note opens the PDF at its page in a viewer beside the card (pdfview.js).

import { pdfViewer } from "./pdfview.js";

const STATE = "dl.timelineView";
const SIZES = [["s", "Narrow", 14], ["m", "Medium", 26], ["l", "Wide", 46]];
const HUES = ["--c-project", "--c-place", "--c-topic", "--c-period", "--c-people", "--c-decade", "--c-collection", "--c-type"];
const COLL = { Proceedings: "Proceedings", Collections: "Collections", Add: "Add", "00_Inbox": "Inbox" };
const SCHEMES = [
  { key: "highlights", label: "Highlights" },
  { key: "project", label: "Project", cat: (b) => [].concat(b.meta?.project ?? [])[0] },
  { key: "collection", label: "Collection", cat: (b) => b.collection && b.collection !== "Authors" ? COLL[b.collection] || b.collection : null },
  { key: "cited", label: "Cited in library", hue: "--c-place" },
  { key: "added", label: "Recently added", hue: "--c-period" },
];

const lastName = (b) => (b.authors || [])[0] || "";

export function viewTimeline(main, ctx) {
  const { books, lib, esc, fold, load, save, byline, tagOptions, hasTag, chipsHtml, annotationHtml, loadImages, isMine } = ctx;
  main.classList.add("wide");
  const v = { show: "all", tag: "", size: "m", undated: false, q: "", scroll: 0, color: "highlights", ...load(STATE, {}) };
  main.innerHTML = `
    <div class="toolbar">
      <input id="tlq" type="search" placeholder="Highlight by title, author or tag" value="${esc(v.q)}" autocomplete="off">
      <div class="seg" role="group" aria-label="Show">
        ${[["all", "All"], ["annotated", "Annotated"], ["tagged", "Summarized"]].map(([k, l]) =>
          `<button data-show="${k}" aria-pressed="${v.show === k}">${l}</button>`).join("")}
      </div>
      <select id="tltag" aria-label="Tag"><option value="">All tags</option>${tagOptions(v.tag)}</select>
      <select id="tlcolor" aria-label="Color by">${SCHEMES.map(({ key, label }) =>
        `<option value="${key}" ${v.color === key ? "selected" : ""}>Color: ${label}</option>`).join("")}</select>
      <div class="seg" role="group" aria-label="Book width">
        ${SIZES.map(([k, l]) => `<button data-size="${k}" aria-pressed="${v.size === k}">${l}</button>`).join("")}
      </div>
      <label class="check"><input type="checkbox" id="tlundated" ${v.undated ? "checked" : ""}> books without a year</label>
    </div>
    <p class="count" id="tlinfo"></p>
    <div class="timeline" id="tl"><div class="tl-track" id="track"></div></div>
    <p class="tl-legend" id="tllegend"></p>
    <div class="tl-below" id="tlbelow"><section class="tl-card" id="tlcard"></section><section class="pv" id="pv" hidden></section></div>`;

  const tl = main.querySelector("#tl"), track = main.querySelector("#track"), info = main.querySelector("#tlinfo");
  const card = main.querySelector("#tlcard"), legend = main.querySelector("#tllegend"), below = main.querySelector("#tlbelow");
  const viewer = pdfViewer(main.querySelector("#pv"), { esc, onClose: () => { below.classList.remove("with-pdf"); card.querySelectorAll(".tl-note.on").forEach((n) => n.classList.remove("on")); } });
  const openPdf = (b, page, rect) => { below.classList.add("with-pdf"); viewer.show(b, page, rect); };
  let shown = [], summary = "", cites = null;

  /** Spine colors for the current scheme: a style per book id, plus the legend under the timeline. */
  const coloring = () => {
    const s = SCHEMES.find((x) => x.key === v.color) || SCHEMES[0];
    const fill = new Map();
    if (s.key === "highlights") {
      const n = shown.filter((b) => b.annotations).length;
      legend.innerHTML = `<span class="sw sw-mark"></span>highlights and notes: the bar grows with the count · ${n} of ${shown.length} books annotated`;
      return fill;
    }
    if (s.cat) { // one hue per value, the most frequent values first; the rest stay gray
      const counts = new Map();
      for (const b of shown) { const c = s.cat(b); if (c) counts.set(c, (counts.get(c) || 0) + 1); }
      const ranked = [...counts].sort((a, b) => b[1] - a[1]);
      const hue = new Map(ranked.slice(0, HUES.length).map(([c], i) => [c, HUES[i]]));
      for (const b of shown) { const h = hue.get(s.cat(b)); if (h) fill.set(b.id, `background: color-mix(in srgb, var(${h}) 45%, var(--bg))`); }
      const none = shown.length - ranked.reduce((t, [, n]) => t + n, 0);
      legend.innerHTML = ranked.map(([c, n]) => `<span class="sw" style="background: color-mix(in srgb, var(${hue.get(c) || "--text"}) ${hue.get(c) ? 45 : 8}%, var(--bg))"></span>${esc(c)} ${n}`).join(" · ") +
        `${ranked.length ? " · " : ""}<span class="sw"></span>${s.key === "project" ? "no project tag" : "Authors folder"} ${none}` +
        (s.key === "project" ? ` <span class="muted">(project tags exist for ${books.filter((b) => s.cat(b)).length} books so far)</span>` : "");
      return fill;
    }
    // one hue, darker = more: times cited by other books here, or rank of the date added (newest darkest)
    let val = new Map(), note = "";
    if (s.key === "cited") {
      if (!cites) { legend.textContent = "loading citations…"; return fill; }
      const n = new Map();
      for (const l of cites.links || []) if (l.from !== l.to) n.set(l.to, (n.get(l.to) || 0) + 1);
      const max = Math.max(1, ...shown.map((b) => n.get(b.id) || 0));
      for (const b of shown) if (n.get(b.id)) val.set(b.id, Math.sqrt(n.get(b.id) / max));
      note = cites.missing ? "no citations yet (tools/citations.py)"
        : `${val.size} of ${shown.length} books cited by others here · most: ${max}× · from ${cites.scanned?.length ?? "?"} scanned books`;
    } else {
      const dated = shown.filter((b) => b.added).sort((a, b) => String(a.added).localeCompare(String(b.added)));
      dated.forEach((b, i) => val.set(b.id, dated.length > 1 ? i / (dated.length - 1) : 1));
      note = dated.length ? `added ${dated[0].added} → ${dated.at(-1).added}` : "no dates";
    }
    for (const [id, x] of val) fill.set(id, `background: color-mix(in srgb, var(${s.hue}) ${Math.round(15 + x * 50)}%, var(--bg))`);
    legend.innerHTML = `${s.key === "cited" ? "cited less" : "earlier"} <span class="ramp" style="--h: var(${s.hue})"></span> ${s.key === "cited" ? "more" : "more recent"} · ${esc(note)}`;
    return fill;
  };

  const render = () => {
    save(STATE, v);
    if (v.color === "cited" && !cites) lib.citations().then((c) => { cites = c || { links: [], missing: true }; render(); });
    const pass = (b) => (v.show !== "annotated" || b.annotations) && (v.show !== "tagged" || b.meta) && (!v.tag || hasTag(b, v.tag));
    const dated = books.filter((b) => b.year && pass(b));
    const undated = books.filter((b) => !b.year && pass(b));
    dated.sort((a, b) => a.year - b.year || fold(lastName(a) || a.title).localeCompare(fold(lastName(b) || b.title)));
    undated.sort((a, b) => fold(lastName(a) || a.title).localeCompare(fold(lastName(b) || b.title)));

    // one column per year (only years that have books), in grid order
    const years = [];
    for (const b of dated) (years.at(-1)?.year === b.year ? years.at(-1) : years[years.push({ year: b.year, books: [] }) - 1]).books.push(b);
    if (v.undated && undated.length) years.push({ year: null, books: undated });
    shown = years.flatMap((y) => y.books);
    const fill = coloring();

    const cell = SIZES.find(([k]) => k === v.size)[2];
    track.style.setProperty("--cell", `${cell}px`);
    track.dataset.size = v.size;
    track.dataset.color = v.color;
    // decade labels only where the decade is wide enough for one (thin early decades share the axis)
    const decadeWidth = new Map();
    for (const y of years) if (y.year) { const d = Math.floor(y.year / 10) * 10; decadeWidth.set(d, (decadeWidth.get(d) || 0) + y.books.length * cell); }
    let prevDecade = null, prevYear = null;
    track.innerHTML = years.map((y) => {
      const decade = y.year && Math.floor(y.year / 10) * 10;
      const newDecade = y.year && decade !== prevDecade;
      const decLabel = newDecade && decadeWidth.get(decade) >= 44;
      const gap = y.year && prevYear && y.year - prevYear > 1 ? y.year - prevYear - 1 : 0; // skipped years, shown as a mark
      prevDecade = decade; prevYear = y.year;
      const w = y.books.length * cell;
      return `<div class="tl-year${newDecade ? " dec" : ""}${gap ? " gap" : ""}${w < 38 ? " narrow" : ""}${y.year ? "" : " nd"}"
          style="width:${w}px" ${gap ? `title="${gap} year${gap > 1 ? "s" : ""} without books before ${y.year}"` : ""}>
        ${decLabel ? `<span class="tl-dec">${decade}s</span>` : ""}
        <div class="tl-books">${y.books.map((b) => {
          const hl = v.color === "highlights" && b.annotations ? Math.round(Math.min(90, 3 + Math.sqrt(b.annotations) * 4)) : 0; // px
          return `<a class="tl-book${b.read ? "" : " unread"}" href="#/book/${b.id}" data-id="${b.id}" style="--hl:${hl}px;${fill.get(b.id) || ""}">
            <span class="t">${esc(b.title)}</span>${v.size === "l" && lastName(b) ? `<span class="a">${esc(lastName(b))}</span>` : ""}</a>`;
        }).join("")}</div>
        <span class="tl-y">${y.year ?? "no year"}</span>
      </div>`;
    }).join("") || `<p class="empty">No books match.</p>`;

    const span = dated.length ? `${dated[0].year}–${dated.at(-1).year}` : "";
    summary = `${shown.length} books${span ? ` · ${span}` : ""} · ${years.filter((y) => y.year).length} years with books` +
      (undated.length && !v.undated ? ` · ${undated.length} without a year not shown` : "");
    info.textContent = summary;
    dim();
    pin(pinned && shown.includes(pinned) ? pinned : null, false); // keep the pinned book if the filters still show it
  };

  // text filter: dim the books that don't match (keeps the grid as it is)
  const dim = () => {
    const words = fold(v.q).split(/\s+/).filter(Boolean);
    const byId = new Map(shown.map((b) => [b.id, b]));
    let hits = 0;
    track.querySelectorAll(".tl-book").forEach((el) => {
      const b = byId.get(el.dataset.id);
      const tags = ["tags", "project", "paper", "use", "type", "place", "period", "people"].flatMap((f) => [].concat(b.meta?.[f] ?? [])).join(" ");
      const hit = !words.length || words.every((w) => fold(`${b.title} ${(b.names || b.authors || []).join(" ")} ${b.year || ""} ${tags}`).includes(w));
      el.classList.toggle("off", !hit);
      if (hit && words.length) hits++;
    });
    info.textContent = words.length ? `${summary} · ${hits} match` : summary;
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
      ${b.meta?.summary ? `<p class="summary">${esc(b.meta.summary)}</p>` : ""}
      ${b.meta ? `<p class="chips">${chipsHtml(b, true)}</p>` : ""}
      ${pinned === b ? `${b.ext === "pdf" ? `<button class="ghost pv-open" id="tlpdf">Open PDF</button>` : ""}<div class="tl-notes" id="tlnotes"></div><a class="open" href="#/book/${b.id}">Book page →</a>`
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
      html += `<div class="tl-note${b.ext === "pdf" ? " go" : ""}" data-i="${i}" title="${b.ext === "pdf" ? "Show in the PDF" : ""}">${annotationHtml(a)}</div>`;
    });
    if (page !== null) html += "</section>";
    box.innerHTML = `<h3>${list.length} highlights and notes</h3>` +
      (foreign ? `<label class="check"><input type="checkbox" id="tlothers" ${othersToo ? "checked" : ""}> also ${foreign} by others</label>` : "") +
      (html || `<p class="muted">Only notes by others in this book.</p>`);
    loadImages(box);
    box.querySelector("#tlothers")?.addEventListener("change", (e) => { othersToo = e.target.checked; fillNotes(b); });
    box.addEventListener("click", (e) => { // a note: show it in the PDF
      const n = e.target.closest(".tl-note.go");
      if (!n || e.target.closest("details, a, input")) return;
      const a = list[+n.dataset.i];
      box.querySelectorAll(".tl-note.on").forEach((x) => x.classList.remove("on"));
      n.classList.add("on");
      openPdf(b, a.page, a.rect);
    });  };
  const pin = (b, scroll = true) => {
    const changed = pinned !== b;
    pinned = b;
    track.querySelectorAll(".tl-book.sel").forEach((el) => el.classList.remove("sel"));
    if (b) track.querySelector(`.tl-book[data-id="${b.id}"]`)?.classList.add("sel");
    if (changed) { inCard = undefined; viewer.close(); } // the same book, now pinned: draw it again with its notes
    showCard(b);
    if (b && changed && scroll && card.getBoundingClientRect().top > innerHeight - 120) card.scrollIntoView({ behavior: "smooth", block: "nearest" });
  };
  const bookAt = (e) => { const el = e.target.closest(".tl-book"); return el && shown.find((x) => x.id === el.dataset.id); };
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
    if (e.target.closest("#tlpdf") && pinned) openPdf(pinned, 1);
  });
  const onKey = (e) => { if (e.key === "Escape") pin(null); };
  document.addEventListener("keydown", onKey);
  main.dispose = () => document.removeEventListener("keydown", onKey);

  // a mouse wheel scrolls along the timeline
  tl.addEventListener("wheel", (e) => {
    if (Math.abs(e.deltaY) <= Math.abs(e.deltaX) || e.ctrlKey) return;
    tl.scrollLeft += e.deltaY;
    e.preventDefault();
  }, { passive: false });
  let t;
  tl.addEventListener("scroll", () => { clearTimeout(t); t = setTimeout(() => { v.scroll = tl.scrollLeft / (tl.scrollWidth || 1); save(STATE, v); }, 200); });

  main.querySelector("#tlq").addEventListener("input", (e) => {
    v.q = e.target.value;
    save(STATE, v);
    dim();
    const first = v.q.trim() && track.querySelector(".tl-book:not(.off)"); // bring the first match into view
    if (first) tl.scrollTo({ left: tl.scrollLeft + first.getBoundingClientRect().left - tl.getBoundingClientRect().left - 40, behavior: "smooth" });
  });
  main.querySelectorAll("[data-show]").forEach((btn) => btn.addEventListener("click", () => {
    v.show = btn.dataset.show;
    main.querySelectorAll("[data-show]").forEach((b) => b.setAttribute("aria-pressed", b === btn));
    render();
  }));
  main.querySelectorAll("[data-size]").forEach((btn) => btn.addEventListener("click", () => {
    const at = tl.scrollLeft / (tl.scrollWidth || 1); // keep the same place in time when the width changes
    v.size = btn.dataset.size;
    main.querySelectorAll("[data-size]").forEach((b) => b.setAttribute("aria-pressed", b === btn));
    render();
    tl.scrollLeft = at * tl.scrollWidth;
  }));
  main.querySelector("#tltag").addEventListener("change", (e) => { v.tag = e.target.value; render(); });
  main.querySelector("#tlcolor").addEventListener("change", (e) => { v.color = e.target.value; render(); });
  main.querySelector("#tlundated").addEventListener("change", (e) => { v.undated = e.target.checked; render(); });

  render();
  tl.scrollLeft = v.scroll * tl.scrollWidth;
}
