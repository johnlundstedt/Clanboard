import { useCallback, useEffect, useState } from "react";
import {
  getAdminSettings, setAdminSettings,
  getTaskCategories, createTaskCategory, updateTaskCategory, deleteTaskCategory,
  getTaskPriorities, createTaskPriority, updateTaskPriority, deleteTaskPriority,
} from "../../api.js";

// Admin panel for the Tasks module: categories, priorities, and the optional
// dollar-value field.
export default function TasksAdminPanel({ onSaved }) {
  const [enableCategories, setEnableCategories] = useState(true);
  const [enablePriorities, setEnablePriorities] = useState(true);
  const [enableDollar, setEnableDollar] = useState(false);

  const [categories, setCategories] = useState([]);
  const [newCategory, setNewCategory] = useState("");
  const [editingCategory, setEditingCategory] = useState(null);

  const [priorities, setPriorities] = useState([]);
  const [newPriority, setNewPriority] = useState("");

  const refresh = useCallback(async () => {
    const [s, cats, pris] = await Promise.all([
      getAdminSettings(), getTaskCategories(), getTaskPriorities(),
    ]);
    setEnableCategories(s.tasks_enable_categories !== false);
    setEnablePriorities(s.tasks_enable_priorities !== false);
    setEnableDollar(!!s.tasks_enable_dollar);
    setCategories(cats);
    setPriorities(pris);
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  async function persistFlags(patch) {
    await setAdminSettings(patch);
    refresh();
    onSaved?.();
  }

  async function addCategory() {
    const name = newCategory.trim();
    if (!name) return;
    await createTaskCategory({ name });
    setNewCategory("");
    onSaved?.();
    refresh();
  }

  async function saveCategory(cat) {
    await updateTaskCategory(cat.id, cat);
    setEditingCategory(null);
    onSaved?.();
    refresh();
  }

  async function setDefaultCategory(cat) {
    await updateTaskCategory(cat.id, { is_default: true });
    onSaved?.();
    refresh();
  }

  async function removeCategory(cat) {
    await deleteTaskCategory(cat.id);
    onSaved?.();
    refresh();
  }

  async function addPriority() {
    const name = newPriority.trim();
    if (!name) return;
    await createTaskPriority({ name });
    setNewPriority("");
    onSaved?.();
    refresh();
  }

  async function savePriority(pri) {
    await updateTaskPriority(pri.id, { name: pri.name });
    refresh();
    onSaved?.();
  }

  async function removePriority(pri) {
    await deleteTaskPriority(pri.id);
    refresh();
    onSaved?.();
  }

  return (
    <div style={{ display: "grid", gap: "1rem" }}>
      <div className="card">
        <h3 style={{ marginTop: 0 }}>Options</h3>
        <div style={{ display: "grid", gap: "0.5rem" }}>
          <label className="row">
            <input
              type="checkbox"
              checked={enableCategories}
              onChange={(e) => persistFlags({ tasks_enable_categories: e.target.checked })}
            />
            Enable task categories
          </label>
          <label className="row">
            <input
              type="checkbox"
              checked={enablePriorities}
              onChange={(e) => persistFlags({ tasks_enable_priorities: e.target.checked })}
            />
            Enable task priorities (High / Medium / Low)
          </label>
          <label className="row">
            <input
              type="checkbox"
              checked={enableDollar}
              onChange={(e) => persistFlags({ tasks_enable_dollar: e.target.checked })}
            />
            Allow a dollar value on tasks
          </label>
        </div>
      </div>

      <div className="card">
        <h3 style={{ marginTop: 0 }}>Task categories</h3>
        <div className="small muted" style={{ marginBottom: "0.5rem" }}>
          One category is the default and is used by the dashboard quick-add.
        </div>
        <div style={{ display: "grid", gap: "0.4rem" }} className="small">
          {categories.map((cat) => (
            <div key={cat.id} className="row" style={{ justifyContent: "space-between" }}>
              {editingCategory?.id === cat.id ? (
                <input
                  className="grow"
                  value={editingCategory.name}
                  onChange={(e) => setEditingCategory((c) => ({ ...c, name: e.target.value }))}
                />
              ) : (
                <div className="row grow">
                  <strong>{cat.name}</strong>
                  {cat.is_default ? <span className="badge green">default</span> : null}
                </div>
              )}
              <span className="row">
                {editingCategory?.id === cat.id ? (
                  <>
                    <button className="primary small" onClick={() => saveCategory(editingCategory)}>Save</button>
                    <button className="small" onClick={() => setEditingCategory(null)}>Cancel</button>
                  </>
                ) : (
                  <>
                    {!cat.is_default && (
                      <button className="small" onClick={() => setDefaultCategory(cat)} title="Make default">
                        ★ Make default
                      </button>
                    )}
                    <button className="small" onClick={() => setEditingCategory(cat)}>Edit</button>
                    <button className="small danger" onClick={() => removeCategory(cat)}>✕</button>
                  </>
                )}
              </span>
            </div>
          ))}
          {categories.length === 0 && <div className="muted">No categories yet.</div>}
        </div>
        <div className="row" style={{ marginTop: "0.6rem" }}>
          <input
            className="grow"
            value={newCategory}
            onChange={(e) => setNewCategory(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && addCategory()}
            placeholder="Add a category…"
          />
          <button onClick={addCategory}>Add</button>
        </div>
      </div>

      <div className="card">
        <h3 style={{ marginTop: 0 }}>Task priorities</h3>
        <div style={{ display: "grid", gap: "0.4rem" }} className="small">
          {priorities.map((pri) => (
            <PriorityRow key={pri.id} pri={pri} onSave={savePriority} onRemove={removePriority} />
          ))}
          {priorities.length === 0 && <div className="muted">No priorities yet.</div>}
        </div>
        <div className="row" style={{ marginTop: "0.6rem" }}>
          <input
            className="grow"
            value={newPriority}
            onChange={(e) => setNewPriority(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && addPriority()}
            placeholder="Add a priority…"
          />
          <button onClick={addPriority}>Add</button>
        </div>
      </div>
    </div>
  );
}

function PriorityRow({ pri, onSave, onRemove }) {
  const [name, setName] = useState(pri.name);
  const [dirty, setDirty] = useState(false);

  return (
    <div className="row" style={{ justifyContent: "space-between" }}>
      <input
        className="grow"
        value={name}
        onChange={(e) => { setName(e.target.value); setDirty(true); }}
        onBlur={() => {
          if (dirty) {
            onSave({ ...pri, name: name.trim() || pri.name });
            setDirty(false);
          }
        }}
      />
      <button className="small danger" onClick={() => onRemove(pri)}>✕</button>
    </div>
  );
}