import { useCallback, useEffect, useState } from "react";
import { Sunrise, Sandwich, CookingPot, Apple } from "lucide-react";
import { getMealWeek, setMealEntry } from "../../api.js";
import { usePolling } from "../../realtime.js";
import AutoTextarea from "../../components/AutoTextarea.jsx";

const SLOTS = [
  ["breakfast", "Breakfast", Sunrise],
  ["lunch", "Lunch", Sandwich],
  ["dinner", "Dinner", CookingPot],
  ["snack", "Snack", Apple],
];

// One example per day (7, cycling through the week) so each day's watermark differs.
// Kept to a single word + "?" for quick glanceability.
const SLOT_HINTS = {
  breakfast: [
    "Pancakes?",
    "Oatmeal?",
    "Waffles?",
    "Yogurt?",
    "Toast?",
    "Cereal?",
    "Eggs?",
  ],
  lunch: [
    "Sandwiches?",
    "Tacos?",
    "Leftovers?",
    "Grilled cheese?",
    "Soup?",
    "Burritos?",
    "Pizza?",
  ],
  dinner: [
    "Lasagna?",
    "Spaghetti?",
    "Stir-fry?",
    "Roast chicken?",
    "Chili?",
    "Fish sticks?",
    "Burgers?",
  ],
  snack: [
    "Grapes?",
    "Apples?",
    "Cheese?",
    "Trail mix?",
    "Popcorn?",
    "Bananas?",
    "Hummus?",
  ],
};

function startOfWeek(date) {
  const d = new Date(date);
  const day = d.getDay(); // 0=Sun
  const diff = day === 0 ? -6 : 1 - day; // Monday start
  d.setDate(d.getDate() + diff);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export default function MealPlanPage({ user }) {
  const [start, setStart] = useState(startOfWeek(new Date()));
  const [entries, setEntries] = useState({});
  const [drafts, setDrafts] = useState({});
  const [saving, setSaving] = useState(new Set());

  const adult = !!user?.is_admin;
  const caps = user?.caps?.["meal-plan"] || {};
  // Module access is controlled by module enablement; the fine-grained "edit"
  // cap only gates whether a member can change entries.
  const canEdit = adult || user?.is_kiosk || !!caps.edit;

  const refresh = useCallback(async () => {
    const res = await getMealWeek(start);
    const map = {};
    for (const e of res.entries) {
      if (!map[e.date]) map[e.date] = {};
      map[e.date][e.meal_slot] = e.text;
    }
    setEntries(map);
  }, [start]);

  usePolling("meal_plan", refresh);

  useEffect(() => { refresh(); }, [refresh]);

  const days = Array.from({ length: 7 }, (_, i) => {
    const d = new Date(`${start}T12:00:00`);
    d.setDate(d.getDate() + i);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  });

  const today = `${new Date().getFullYear()}-${String(new Date().getMonth() + 1).padStart(2, "0")}-${String(new Date().getDate()).padStart(2, "0")}`;

  async function save(date, slot) {
    if (!canEdit) return;
    const text = drafts[`${date}:${slot}`] !== undefined ? drafts[`${date}:${slot}`] : (entries[date]?.[slot] || "");
    setSaving((s) => new Set(s).add(`${date}:${slot}`));
    try {
      await setMealEntry(date, slot, text);
      setEntries((prev) => {
        const newMap = { ...prev };
        if (!newMap[date]) newMap[date] = {};
        if (text.trim()) newMap[date][slot] = text.trim();
        else delete newMap[date][slot];
        return newMap;
      });
      setDrafts((d) => { const nd = { ...d }; delete nd[`${date}:${slot}`]; return nd; });
    } finally {
      setSaving((s) => { const ns = new Set(s); ns.delete(`${date}:${slot}`); return ns; });
    }
  }

  function shiftWeek(n) {
    const d = new Date(`${start}T12:00:00`);
    d.setDate(d.getDate() + n * 7);
    setStart(startOfWeek(d));
  }

  return (
    <div>
      <div className="row wrap" style={{ justifyContent: "space-between", marginBottom: "1rem" }}>
        <h1 style={{ margin: 0 }}>Meals</h1>
        <div className="row">
          <button onClick={() => shiftWeek(-1)}>←</button>
          <strong>
            {days[0].slice(5).replace("-", "/")} – {days[6].slice(5).replace("-", "/")}
          </strong>
          <button onClick={() => shiftWeek(1)}>→</button>
          <button onClick={() => setStart(startOfWeek(new Date()))}>This week</button>
        </div>
      </div>

      <div className="meal-grid">
        <div className="meal-corner">Week</div>
        {days.map((date, i) => {
          const weekday = new Date(`${date}T12:00:00`).toLocaleDateString(undefined, { weekday: "short" });
          const isToday = date === today;
          return (
            <div key={date} className={`meal-day-head ${isToday ? "today" : ""}`}>
              {weekday} <span>{date.slice(8)}</span>
              {isToday && <em>today</em>}
            </div>
          );
        })}

        {SLOTS.map(([slot, label, Icon]) => (
          <MealRow
            key={slot}
            slot={slot}
            label={label}
            Icon={Icon}
            days={days}
            drafts={drafts}
            entries={entries}
            saving={saving}
            canEdit={canEdit}
            onDraft={setDrafts}
            onSave={save}
          />
        ))}
      </div>

      {!canEdit && (
        <p className="small muted" style={{ marginTop: "1rem" }}>
          You can view this week's meals, but your role doesn't allow editing.
        </p>
      )}
      {canEdit && (
        <p className="small muted" style={{ marginTop: "1rem" }}>
          Tap a slot and type — eating is whatever you wrote. Enter adds a new line; changes save automatically when you leave the box.
        </p>
      )}
    </div>
  );
}

// One grid row: the slot label (icon over text) plus a textarea per day, all
// on the same CSS grid row so the label centers exactly against the cell.
function MealRow({ slot, label, Icon, days, drafts, entries, saving, canEdit, onDraft, onSave }) {
  return (
    <>
      <div className="meal-slot-label">
        <Icon size={20} />
        <span>{label}</span>
      </div>
      {days.map((date, i) => (
        <div key={date} className="meal-slot">
          <AutoTextarea
            rows={4}
            value={drafts[`${date}:${slot}`] !== undefined ? drafts[`${date}:${slot}`] : (entries[date]?.[slot] || "")}
            onChange={(e) => onDraft((d) => ({ ...d, [`${date}:${slot}`]: e.target.value }))}
            onBlur={() => onSave(date, slot)}
            onKeyDown={(e) => {
              if ((e.ctrlKey || e.metaKey) && e.key === "Enter") e.target.blur();
            }}
            placeholder={SLOT_HINTS[slot][i]}
            disabled={!canEdit || saving.has(`${date}:${slot}`)}
          />
        </div>
      ))}
    </>
  );
}