// Theme resolution. The member's choice lives on their account ("system",
// "light" or "dark") and lands on <html> as data-theme, which is the single
// switch styles.css keys off. The small inline script in index.html sets the
// same attribute before first paint from localStorage, so the app never flashes
// light before the session resolves — this module owns it afterwards.

const KEY = "clanboard.theme";
const THEMES = ["system", "light", "dark"];

function prefersDark() {
  return typeof matchMedia === "function" && matchMedia("(prefers-color-scheme: dark)").matches;
}

// "system" becomes a concrete theme here: the OS choice is a moving target
// (it can flip at sunset, or mid-session), so we resolve it to "light"/"dark"
// and subscribe rather than leaving the CSS to decide.
export function resolveTheme(theme) {
  if (theme === "light" || theme === "dark") return theme;
  return prefersDark() ? "dark" : "light";
}

export function normalizeTheme(value) {
  return THEMES.includes(value) ? value : "system";
}

// Persist the member's *preference* (not the resolved value), so "system" still
// tracks the device after a reload.
function remember(theme) {
  try {
    localStorage.setItem(KEY, normalizeTheme(theme));
  } catch {
    /* private mode / storage disabled — the session still works */
  }
}

// Apply a member's theme. Returns a cleanup function that stops listening for
// OS changes and restores the remembered theme (used on sign-out, so the login
// screen isn't stuck in the previous member's dark mode).
export function applyTheme(theme) {
  const preference = normalizeTheme(theme);
  const root = document.documentElement;

  const paint = () => {
    const resolved = resolveTheme(preference);
    root.dataset.theme = resolved;
    // Native form controls, scrollbars and the PWA title bar follow color-scheme.
    root.style.colorScheme = resolved;
    remember(preference);
  };
  paint();

  let mq = null;
  const onChange = () => {
    if (preference === "system") paint();
  };
  if (preference === "system" && typeof matchMedia === "function") {
    mq = matchMedia("(prefers-color-scheme: dark)");
    mq.addEventListener?.("change", onChange);
  }

  return () => {
    mq?.removeEventListener?.("change", onChange);
    const stored = (() => {
      try {
        return localStorage.getItem(KEY);
      } catch {
        return null;
      }
    })();
    root.dataset.theme = resolveTheme(stored);
    root.style.colorScheme = root.dataset.theme;
  };
}

// Applied by App.jsx once the session is known. Kept separate from applyTheme so
// the effect can depend on just the preference value.
export { THEMES };