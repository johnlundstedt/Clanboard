import { useEffect, useState } from "react";
import { Search } from "lucide-react";
import { iconCatalog, resolveIcon } from "./TaskIcons.jsx";

// Renders a small icon for a task by name.
export function TaskIcon({ name, size = 18 }) {
  const Icon = resolveIcon(name);
  return <Icon size={size} style={{ verticalAlign: "-2px", color: "var(--muted)" }} />;
}

// A popover picker: search box + grid of icons. Shows a "refresh/auto" control
// to clear the manual choice back to auto-assign.
export function IconPicker({ value, onChange }) {
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);

  const filtered = iconCatalog.filter(([, keywords]) =>
    keywords.toLowerCase().includes(query.trim().toLowerCase())
  );

  return (
    <div style={{ position: "relative" }}>
      <div className="row" style={{ gap: "0.4rem" }}>
        <button
          type="button"
          className="row"
          style={{ gap: "6px", padding: "0.3rem 0.6rem" }}
          onClick={() => setOpen((v) => !v)}
        >
          {value ? (
            <TaskIcon name={value} size={18} />
          ) : (
            <span style={{ color: "var(--muted)" }}>auto</span>
          )}
          <span className="small muted">icon</span>
        </button>
      </div>

      {open && (
        <>
          <div
            style={{ position: "fixed", inset: 0, zIndex: 20 }}
            onClick={() => setOpen(false)}
          />
          <div
            className="card"
            style={{
              position: "absolute", zIndex: 30, top: "110%", left: 0,
              width: 280, padding: "0.6rem",
            }}
          >
            <div className="row" style={{ marginBottom: "0.5rem" }}>
              <Search size={16} style={{ color: "var(--muted)" }} />
              <input
                autoFocus
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search icons…"
                style={{ flex: 1, minWidth: 0 }}
              />
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(8, 1fr)", gap: "2px", maxHeight: 180, overflowY: "auto" }}>
              {filtered.map(([name]) => {
                const Icon = resolveIcon(name);
                return (
                  <button
                    key={name}
                    type="button"
                    title={name}
                    onClick={() => { onChange(name); setOpen(false); }}
                    style={{
                      display: "flex", alignItems: "center", justifyContent: "center",
                      padding: "4px", border: "none", background: "transparent",
                      borderRadius: 6,
                      color: value === name ? "var(--accent)" : undefined,
                      background: value === name ? "#eff6ff" : undefined,
                    }}
                  >
                    <Icon size={18} />
                  </button>
                );
              })}
              {filtered.length === 0 && (
                <span className="small muted" style={{ gridColumn: "1 / -1" }}>No icons found</span>
              )}
            </div>
            <button
              type="button"
              className="small"
              style={{ marginTop: "0.5rem", width: "100%" }}
              onClick={() => { onChange(null); setOpen(false); }}
            >
              ↺ Use auto-assigned icon
            </button>
          </div>
        </>
      )}
    </div>
  );
}