import { useEffect, useState } from "react";
import { RefreshCw } from "lucide-react";
import { requestRefresh } from "./realtime.js";

// Desktop PWAs installed with the Window Controls Overlay display mode run with
// no browser chrome: the app's content extends under the OS title bar and the
// minimize/maximize/close buttons float on top of the top-right (Windows/Linux)
// or top-left (macOS) corner. A browser-installed page has no such strip — the
// overlay env() variables are empty then and this component renders nothing.
export default function TitleBar() {
  const [active, setActive] = useState(() => !!navigator.windowControlsOverlay?.visible);
  const [spinning, setSpinning] = useState(false);

  useEffect(() => {
    const wco = navigator.windowControlsOverlay;
    if (!wco) return;
    function onGeometry() {
      setActive(wco.visible);
    }
    wco.addEventListener("geometrychange", onGeometry);
    return () => wco.removeEventListener("geometrychange", onGeometry);
  }, []);

  useEffect(() => {
    if (!spinning) return;
    const t = setTimeout(() => setSpinning(false), 600);
    return () => clearTimeout(t);
  }, [spinning]);

  if (!active) return null;

  return (
    <div className="title-bar">
      <button
        className="title-bar-refresh"
        title="Refresh"
        onClick={() => {
          setSpinning(true);
          requestRefresh();
        }}
      >
        <RefreshCw size={16} className={spinning ? "spin" : ""} />
      </button>
    </div>
  );
}