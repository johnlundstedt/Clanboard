// App-launcher badge via the Badging API: shows a count on the installed app's
// icon (Chromium PWAs on Android/desktop). No-op everywhere else — the API is
// absent (Safari/Firefox), requires the app to be installed, and some engines
// reject the call without a focus gesture, so every operation is feature-
// detected and errors are swallowed. Zero badge means "clear".
export function updateAppBadge(count) {
  if (!("setAppBadge" in navigator) || !("clearAppBadge" in navigator)) return;
  const value = Number(count) || 0;
  const op = value > 0 ? navigator.setAppBadge(value) : navigator.clearAppBadge();
  if (op && typeof op.catch === "function") op.catch(() => {});
}