// Theme + style, shared by Nicolas's apps (hub: templates/styles/theme.js; copy into an app as js/theme.js with
// scripts/sync-styles.ps1, don't edit the copies).
// - Theme: light / dark. Follows the system setting unless Settings overrides it  -> <html data-theme>.
// - Style: the look on top of the theme. "standard" = the app's own CSS, "hud" = css/styles/hud.css (+ the app's
//   own hud mapping), or a custom style the app registers  -> <html data-style>.
// Fires "themechange" so canvases and charts redraw (again once a style's web fonts have arrived).
// In <head>, before the stylesheets (no flash of the wrong look):
//   <script>try{var s=localStorage,m=s.getItem("theme")||"system",d=document.documentElement;d.dataset.theme=m==="system"?(matchMedia("(prefers-color-scheme: dark)").matches?"dark":"light"):m;d.dataset.style=s.getItem("style")||"standard"}catch(e){}</script>

const THEME_KEY = "theme";
const STYLE_KEY = "style";
const mq = matchMedia("(prefers-color-scheme: dark)");

/** Styles offered in Settings. An app adds its own with registerStyle({ id, label, fonts? }). */
export const STYLES = [
  { id: "standard", label: "Standard" },
  {
    id: "hud",
    label: "HUD",
    fonts: "https://fonts.googleapis.com/css2?family=Chakra+Petch:wght@500;600&family=IBM+Plex+Mono:wght@400;500&family=IBM+Plex+Sans:wght@400;500;600&display=swap",
  },
];
export function registerStyle(style) {
  if (!STYLES.some((s) => s.id === style.id)) STYLES.push(style);
}
const known = (id) => STYLES.some((s) => s.id === id);

// ?style=hud in the URL switches and remembers the style (for previews and links)
const fromUrl = new URLSearchParams(location.search).get("style");
if (known(fromUrl)) try { localStorage.setItem(STYLE_KEY, fromUrl); } catch { /* private mode */ }

export const getThemeMode = () => { try { return localStorage.getItem(THEME_KEY) || "system"; } catch { return "system"; } };
export function setThemeMode(mode) {
  try { localStorage.setItem(THEME_KEY, mode); } catch { /* private mode: session only */ }
  applyTheme();
}

export function getStyle() {
  let id = null;
  try { id = localStorage.getItem(STYLE_KEY); } catch { /* private mode */ }
  id ??= fromUrl;
  return known(id) ? id : "standard";
}
export function setStyle(id) {
  try { localStorage.setItem(STYLE_KEY, id); } catch { /* private mode: session only */ }
  applyTheme();
}

export function applyTheme() {
  const mode = getThemeMode();
  const theme = mode === "system" ? (mq.matches ? "dark" : "light") : mode;
  const style = STYLES.find((s) => s.id === getStyle());
  const root = document.documentElement;
  root.dataset.theme = theme;
  root.dataset.style = style.id;
  // a style's web fonts are only fetched while it is on; drawings redraw once they are there
  if (style.fonts && !document.getElementById(`fonts-${style.id}`)) {
    document.head.insertAdjacentHTML("beforeend", `<link id="fonts-${style.id}" rel="stylesheet" href="${style.fonts}">`);
    document.fonts?.ready.then(() => dispatchEvent(new CustomEvent("themechange", { detail: theme })));
  }
  const bg = getComputedStyle(root).getPropertyValue("--bg").trim();
  document.querySelector('meta[name="theme-color"]')?.setAttribute("content", bg);
  dispatchEvent(new CustomEvent("themechange", { detail: theme }));
}

mq.addEventListener("change", () => { if (getThemeMode() === "system") applyTheme(); });
applyTheme();
