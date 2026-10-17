// Theme (hub design baseline): follows the system light/dark setting unless Settings overrides it.
// Sets <html data-theme>, keeps the browser bar color in step, and fires "themechange" so canvases redraw.
const KEY = "theme";
const mq = matchMedia("(prefers-color-scheme: dark)");

export const getThemeMode = () => { try { return localStorage.getItem(KEY) || "system"; } catch { return "system"; } };
export function setThemeMode(mode) {
  try { localStorage.setItem(KEY, mode); } catch { /* private mode: session only */ }
  applyTheme();
}
export function applyTheme() {
  const mode = getThemeMode();
  const theme = mode === "system" ? (mq.matches ? "dark" : "light") : mode;
  document.documentElement.dataset.theme = theme;
  const bg = getComputedStyle(document.documentElement).getPropertyValue("--bg").trim();
  document.querySelector('meta[name="theme-color"]')?.setAttribute("content", bg);
  dispatchEvent(new CustomEvent("themechange", { detail: theme }));
}
mq.addEventListener("change", () => { if (getThemeMode() === "system") applyTheme(); });
applyTheme();
