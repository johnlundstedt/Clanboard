import { useEffect, useRef } from "react";

// Textarea that grows to fit its content instead of showing an internal
// scrollbar. Sized after every render so it tracks external value changes too.
export default function AutoTextarea(props) {
  const ref = useRef(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  });

  return <textarea ref={ref} {...props} />;
}