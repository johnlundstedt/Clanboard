import { useEffect, useRef } from "react";

// Keep the device screen awake while `active` is true. Browsers release the
// lock when the tab is hidden, so re-request it whenever the tab becomes
// visible again. No-op where the Screen Wake Lock API isn't available.
export default function useWakeLock(active) {
  const lockRef = useRef(null);

  useEffect(() => {
    if (!active || !("wakeLock" in navigator)) return;
    let cancelled = false;

    async function request() {
      if (cancelled) return;
      if (lockRef.current) {
        lockRef.current.release().catch(() => {});
        lockRef.current = null;
      }
      try {
        lockRef.current = await navigator.wakeLock.request("screen");
      } catch {
        lockRef.current = null;
      }
    }

    function onVisibility() {
      if (document.visibilityState === "visible") request();
    }

    request();
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      cancelled = true;
      if (lockRef.current) {
        lockRef.current.release().catch(() => {});
        lockRef.current = null;
      }
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [active]);
}