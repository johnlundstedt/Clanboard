import { useCallback, useEffect, useState } from "react";
import {
  getAdminSettings, setAdminSettings,
  getTaskCategories, createTaskCategory, updateTaskCategory, deleteTaskCategory,
} from "../../api.js";

// Admin panel for the Tasks module: categories and the category default.
export default function TasksAdminPanel({ onSaved }) {
  const [enableCategories, setEnableCategories] = useState(true);

  const [categories, setCategories] = useState([]);
  const [newCategory, setNewCategory] = useState("");
  const [editingCategory, setEditingCategory] = useState(null);

  const refresh = useCallback(async () => {
    const [s, cats] = await Promise.all([
      getAdminSettings(), getTaskCategories(),
    ]);
    setEnableCategories(s.tasks_enable_categories !== false);
    setCategories(cats);
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
    </div>
  );
}