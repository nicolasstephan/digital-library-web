// Theme (hub design baseline): follows the system light/dark setting unless Settings overrides it.
// Sets <html data-theme>, keeps the browser bar color in step, and fires "themechange" so canvases redraw.
// Style (test): "standard" or "hud" (css/hud.css, hub: templates/references) on <html data-style>, independent of light/dark.
const KEY = "theme";
const STYLE = "style";
const FONTS = "https://fonts.googleapis.com/css2?family=Chakra+Petch:wght@500;600&family=IBM+Plex+Mono:wght@400;500&family=IBM+Plex+Sans:wght@400;500;600&display=swap";
const mq = matchMedia("(prefers-color-scheme: dark)");
// ?style=hud or ?style=standard in the URL switches and remembers the style (for previews)
const fromUrl = new URLSearchParams(location.search).get("style");
if (fromUrl === "hud" || fromUrl === "standard") try { localStorage.setItem(STYLE, fromUrl); } catch { /* private mode */ }

export const getThemeMode = () => { try { return localStorage.getItem(KEY) || "system"; } catch { return "system"; } };
export function setThemeMode(mode) {
  try { localStorage.setItem(KEY, mode); } catch { /* private mode: session only */ }
  applyTheme();
}
export const getStyle = () => { try { return localStorage.getItem(STYLE) || fromUrl || "standard"; } catch { return fromUrl || "standard"; } };
export function setStyle(style) {
  try { localStorage.setItem(STYLE, style); } catch { /* private mode: session only */ }
  applyTheme();
}
export function applyTheme() {
  const mode = getThemeMode();
  const theme = mode === "system" ? (mq.matches ? "dark" : "light") : mode;
  const style = getStyle();
  document.documentElement.dataset.theme = theme;
  document.documentElement.dataset.style = style;
  // the HUD fonts are only fetched when that style is on; canvases redraw once they arrive
  if (style === "hud" && !document.getElementById("hud-fonts")) {
    document.head.insertAdjacentHTML("beforeend", `<link id="hud-fonts" rel="stylesheet" href="${FONTS}">`);
    document.fonts?.ready.then(() => dispatchEvent(new CustomEvent("themechange", { detail: theme })));
  }
  const bg = getComputedStyle(document.documentElement).getPropertyValue("--bg").trim();
  document.querySelector('meta[name="theme-color"]')?.setAttribute("content", bg);
  dispatchEvent(new CustomEvent("themechange", { detail: theme }));
}
mq.addEventListener("change", () => { if (getThemeMode() === "system") applyTheme(); });
applyTheme();
