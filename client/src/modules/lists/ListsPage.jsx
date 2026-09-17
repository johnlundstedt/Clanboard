import { useCallback, useEffect, useState } from "react";
import {
  getLists, createList, deleteList, addListItem, toggleListItem, deleteListItem,
} from "../../api.js";
import { usePolling } from "../../realtime.js";

export default function ListsPage({ user }) {
  const [lists, setLists] = useState([]);
  const [drafts, setDrafts] = useState({});
  const [newListName, setNewListName] = useState("");

  const adult = !!user?.is_admin;
  const caps = user?.caps?.lists || {};
  const canCreateLists = adult || user?.is_kiosk || !!caps.create_lists;
  const canDeleteLists = adult || user?.is_kiosk || !!caps.delete_lists;
  const canAddItems = adult || user?.is_kiosk || !!caps.add_items;
  const canRemoveItems = adult || user?.is_kiosk || !!caps.remove_items;
  const canCompleteItems = adult || user?.is_kiosk || !!caps.complete_items;

  const refresh = useCallback(async () => {
    setLists(await getLists());
  }, []);

  usePolling("lists", refresh);

  useEffect(() => { refresh(); }, [refresh]);

  async function handleAdd(listId) {
    const text = (drafts[listId] || "").trim();
    if (!text) return;
    await addListItem(listId, text);
    setDrafts((d) => ({ ...d, [listId]: "" }));
    refresh();
  }

  async function handleToggle(itemId, checked) {
    await toggleListItem(itemId, checked);
    refresh();
  }

  async function handleDeleteItem(itemId) {
    await deleteListItem(itemId);
    refresh();
  }

  async function handleCreateList() {
    if (!newListName.trim()) return;
    await createList(newListName.trim());
    setNewListName("");
    refresh();
  }

  async function handleDeleteList(list) {
    if (confirm(`Delete list "${list.name}"?`)) {
      await deleteList(list.id);
      refresh();
    }
  }

  return (
    <div>
      <h1 style={{ marginTop: 0 }}>Lists</h1>

      {canCreateLists && (
        <div className="card" style={{ marginBottom: "1rem" }}>
          <div className="row">
            <input
              className="grow"
              value={newListName}
              onChange={(e) => setNewListName(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && handleCreateList()}
              placeholder="New list name…"
            />
            <button className="primary" onClick={handleCreateList}>Create list</button>
          </div>
        </div>
      )}

      <div style={{ display: "grid", gap: "1rem" }}>
        {lists.map((list) => {
          const uncheckedItems = list.items.filter((i) => !i.checked);
          const checkedItems = list.items.filter((i) => i.checked);
          const renderItem = (item) => (
            <div key={item.id} className="row">
              <input
                type="checkbox"
                className="check"
                disabled={!canCompleteItems}
                checked={!!item.checked}
                onChange={(e) => handleToggle(item.id, e.target.checked)}
              />
              <span
                className="grow"
                style={{ textDecoration: item.checked ? "line-through" : "none", color: item.checked ? "var(--muted)" : undefined }}
              >
                {item.text}
              </span>
              {canRemoveItems && <button className="small danger" onClick={() => handleDeleteItem(item.id)}>✕</button>}
            </div>
          );
          return (
            <div key={list.id} className="card">
              <div className="row" style={{ justifyContent: "space-between", marginBottom: "0.5rem" }}>
                <h2 style={{ margin: 0, fontSize: "1.25rem" }}>{list.name}</h2>
                {canDeleteLists && <button className="small danger" onClick={() => handleDeleteList(list)}>Delete</button>}
              </div>

              {uncheckedItems.length > 0 && (
                <div style={{ display: "grid", gap: "0.25rem", marginBottom: "0.5rem" }}>
                  {uncheckedItems.map(renderItem)}
                </div>
              )}

              {canAddItems && (
                <div className="row">
                  <input
                    className="grow"
                    value={drafts[list.id] || ""}
                    onChange={(e) => setDrafts((d) => ({ ...d, [list.id]: e.target.value }))}
                    onKeyDown={(e) => e.key === "Enter" && handleAdd(list.id)}
                    placeholder={`Add to ${list.name}…`}
                  />
                  <button onClick={() => handleAdd(list.id)}>Add</button>
                </div>
              )}

              {checkedItems.length > 0 && (
                <div style={{ display: "grid", gap: "0.25rem", marginTop: "0.5rem", opacity: 0.75 }}>
                  {checkedItems.map(renderItem)}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}