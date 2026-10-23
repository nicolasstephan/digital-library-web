// Timeline view: books in order of publication on a one-dimensional grid. Every book is one cell of the same
// width, so a year is as wide as the books it holds: busy years stretch out, empty years take no room at all.
// Books are spines (title upright, author below); the yellow bar at the foot grows with the highlights in it.
// Filters drop books from the grid (the years close up); the text filter only dims what doesn't match.
// Hovering a spine shows the book in a card under the timeline; a click pins the card, its link opens the notes.

const STATE = "dl.timelineView";
const SIZES = [["s", "Narrow", 14], ["m", "Medium", 26], ["l", "Wide", 46]];

const lastName = (b) => (b.authors || [])[0] || "";

export function viewTimeline(main, { books, esc, fold, load, save, byline, tagOptions, hasTag, chipsHtml }) {
  main.classList.add("wide");
  const v = { show: "all", tag: "", size: "m", undated: false, q: "", scroll: 0, ...load(STATE, {}) };
  main.innerHTML = `
    <div class="toolbar">
      <input id="tlq" type="search" placeholder="Highlight by title, author or tag" value="${esc(v.q)}" autocomplete="off">
      <div class="seg" role="group" aria-label="Show">
        ${[["all", "All"], ["annotated", "Annotated"], ["tagged", "Summarized"]].map(([k, l]) =>
          `<button data-show="${k}" aria-pressed="${v.show === k}">${l}</button>`).join("")}
      </div>
      <select id="tltag" aria-label="Tag"><option value="">All tags</option>${tagOptions(v.tag)}</select>
      <div class="seg" role="group" aria-label="Book width">
        ${SIZES.map(([k, l]) => `<button data-size="${k}" aria-pressed="${v.size === k}">${l}</button>`).join("")}
      </div>
      <label class="check"><input type="checkbox" id="tlundated" ${v.undated ? "checked" : ""}> books without a year</label>
    </div>
    <p class="count" id="tlinfo"></p>
    <div class="timeline" id="tl"><div class="tl-track" id="track"></div></div>
    <section class="tl-card" id="tlcard"></section>`;

  const tl = main.querySelector("#tl"), track = main.querySelector("#track"), info = main.querySelector("#tlinfo");
  const card = main.querySelector("#tlcard");
  let shown = [], summary = "";

  const render = () => {
    save(STATE, v);
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

    const cell = SIZES.find(([k]) => k === v.size)[2];
    track.style.setProperty("--cell", `${cell}px`);
    track.dataset.size = v.size;
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
          const hl = b.annotations ? Math.round(Math.min(90, 3 + Math.sqrt(b.annotations) * 4)) : 0; // px
          return `<a class="tl-book${b.read ? "" : " unread"}" href="#/book/${b.id}" data-id="${b.id}" style="--hl:${hl}px">
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
    pin(pinned && shown.includes(pinned) ? pinned : null); // keep the pinned book if the filters still show it
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

  // book card under the timeline: hovering previews a book, a click pins it (the card stays, "Open" goes to the notes)
  let pinned = null;
  const showCard = (b) => {
    if (!b) { card.innerHTML = `<p class="hint">Point at a book to see it here; click to keep it open.</p>`; return; }
    const facts = [b.collection && b.collection !== "Authors" ? b.collection : "", b.pages ? `${b.pages} pages` : "",
      b.annotations ? `${b.annotations} annotations` : b.read ? "no annotations" : "not read yet", b.added ? `added ${b.added}` : ""].filter(Boolean);
    card.innerHTML = `
      ${pinned === b ? `<button class="close" aria-label="Close" title="Close">×</button>` : ""}
      <h2>${esc(b.title)}</h2>
      <p class="meta">${esc(byline(b))}${facts.length ? ` · ${esc(facts.join(" · "))}` : ""}</p>
      ${b.meta?.summary ? `<p class="summary">${esc(b.meta.summary)}</p>` : ""}
      ${b.meta ? `<p class="chips">${chipsHtml(b, true)}</p>` : ""}
      ${pinned === b ? `<a class="open" href="#/book/${b.id}">Open highlights and notes →</a>` : `<p class="hint">Click to keep this open</p>`}`;
  };
  const pin = (b) => {
    pinned = b;
    track.querySelectorAll(".tl-book.sel").forEach((el) => el.classList.remove("sel"));
    if (b) track.querySelector(`.tl-book[data-id="${b.id}"]`)?.classList.add("sel");
    showCard(b);
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
  card.addEventListener("click", (e) => { if (e.target.closest(".close")) pin(null); });
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
  main.querySelector("#tlundated").addEventListener("change", (e) => { v.undated = e.target.checked; render(); });

  render();
  tl.scrollLeft = v.scroll * tl.scrollWidth;
}
