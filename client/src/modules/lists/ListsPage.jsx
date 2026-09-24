import { useCallback, useEffect, useState } from "react";
import { MoreVertical, Maximize, Minimize } from "lucide-react";
import {
  getLists, createList, deleteList, addListItem, toggleListItem, updateListItem, moveListItem, deleteListItem,
} from "../../api.js";
import { usePolling } from "../../realtime.js";
import useWakeLock from "../../useWakeLock.js";
import { storeLogoUrl } from "./storeLogos.js";

export default function ListsPage({ user }) {
  const [lists, setLists] = useState([]);
  const [drafts, setDrafts] = useState({});
  const [newListName, setNewListName] = useState("");
  const [menuFor, setMenuFor] = useState(null); // list id with the options menu open
  const [fullscreenId, setFullscreenId] = useState(null); // list id shown full screen
  const [editingItemId, setEditingItemId] = useState(null); // item id being edited in place
  const [itemMenuFor, setItemMenuFor] = useState(null); // item id with the edit menu open

  const adult = !!user?.is_admin;
  const caps = user?.caps?.lists || {};
  const canCreateLists = adult || user?.is_kiosk || !!caps.create_lists;
  const canDeleteLists = adult || user?.is_kiosk || !!caps.delete_lists;
  const canAddItems = adult || user?.is_kiosk || !!caps.add_items;
  const canRemoveItems = adult || user?.is_kiosk || !!caps.remove_items;
  const canCompleteItems = adult || user?.is_kiosk || !!caps.complete_items;
  const canEditItems = adult || user?.is_kiosk || !!caps.add_items;

  // Keep the device screen awake while a list is shown full screen (the same
  // wake lock the kiosk display uses). Released when full-screen mode closes.
  useWakeLock(!!fullscreenId);

  const refresh = useCallback(async () => {
    setLists(await getLists());
  }, []);

  usePolling("lists", refresh);

  useEffect(() => { refresh(); }, [refresh]);

  // Escape exits full-screen mode too.
  useEffect(() => {
    if (!fullscreenId) return;
    function onKey(e) {
      if (e.key === "Escape") setFullscreenId(null);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [fullscreenId]);

  const fullscreenList = fullscreenId
    ? lists.find((l) => l.id === fullscreenId) || null
    : null;

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
    if (editingItemId === itemId) {
      setEditingItemId(null);
      setItemMenuFor(null);
    }
    refresh();
  }

  // Save an item's edited text. An empty value or an unchanged one just closes
  // the editor (the item is left alone).
  async function handleUpdateItem(item, text) {
    const trimmed = text.trim();
    if (!trimmed || trimmed === item.text) {
      setEditingItemId(null);
      setItemMenuFor(null);
      return;
    }
    await updateListItem(item.id, trimmed);
    setEditingItemId(null);
    setItemMenuFor(null);
    refresh();
  }

  // Move an item to another list, then close the editor.
  async function handleMoveItem(itemId, listId) {
    await moveListItem(itemId, listId);
    setEditingItemId(null);
    setItemMenuFor(null);
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
      if (fullscreenId === list.id) setFullscreenId(null);
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
            <button className="primary" onClick={handleCreateList}>Create</button>
          </div>
        </div>
      )}

      <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr)", gap: "1rem" }}>
        {lists.map((list) => (
          <ListCard
            key={list.id}
            list={list}
            canAddItems={canAddItems}
            canRemoveItems={canRemoveItems}
            canCompleteItems={canCompleteItems}
            canEditItems={canEditItems}
            canDeleteLists={canDeleteLists}
            drafts={drafts}
            menuFor={menuFor}
            onMenuChange={setMenuFor}
            onDraftChange={(listId, text) => setDrafts((d) => ({ ...d, [listId]: text }))}
            onAdd={handleAdd}
            onToggle={handleToggle}
            onDeleteItem={handleDeleteItem}
            onDeleteList={handleDeleteList}
            onFullscreen={() => setFullscreenId(list.id)}
            editingItemId={editingItemId}
            itemMenuFor={itemMenuFor}
            lists={lists}
            onStartEdit={(itemId) => { setEditingItemId(itemId); setItemMenuFor(null); }}
            onUpdateItem={handleUpdateItem}
            onMoveItem={handleMoveItem}
            onItemMenuChange={setItemMenuFor}
            onCancelEdit={() => { setEditingItemId(null); setItemMenuFor(null); }}
          />
        ))}
      </div>

      {fullscreenList && (
        <FullscreenList
          list={fullscreenList}
          canAddItems={canAddItems}
          canRemoveItems={canRemoveItems}
          canCompleteItems={canCompleteItems}
          canEditItems={canEditItems}
          draft={drafts[fullscreenList.id] || ""}
          onDraftChange={(text) => setDrafts((d) => ({ ...d, [fullscreenList.id]: text }))}
          onAdd={handleAdd}
          onToggle={handleToggle}
          onDeleteItem={handleDeleteItem}
          onClose={() => setFullscreenId(null)}
          editingItemId={editingItemId}
          itemMenuFor={itemMenuFor}
          lists={lists}
          onStartEdit={(itemId) => { setEditingItemId(itemId); setItemMenuFor(null); }}
          onUpdateItem={handleUpdateItem}
          onMoveItem={handleMoveItem}
          onItemMenuChange={setItemMenuFor}
          onCancelEdit={() => { setEditingItemId(null); setItemMenuFor(null); }}
        />
      )}
    </div>
  );
}

function ListItem({ item, canCompleteItems, canEditItems, canRemoveItems, lists, editing, menuOpen, onToggle, onDelete, onStartEdit, onSave, onCancel, onMove, onMenuChange }) {
  const [draft, setDraft] = useState(item.text);

  useEffect(() => {
    if (editing) setDraft(item.text);
  }, [editing, item.text]);

  if (editing) {
    const otherLists = lists.filter((l) => l.id !== item.list_id);
    return (
      <div className="row" style={{ padding: "0.2rem 0" }}>
        <input
          autoFocus
          className="grow"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={() => { if (!menuOpen) onSave(item, draft); }}
          onKeyDown={(e) => {
            if (e.key === "Enter") onSave(item, draft);
            else if (e.key === "Escape") onCancel();
          }}
        />
        <span style={{ position: "relative" }}>
          {(canRemoveItems || otherLists.length > 0) && (
            <button
              className="icon-btn"
              title="Item options"
              aria-label={`Options for ${item.text}`}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => onMenuChange(menuOpen ? null : item.id)}
            >
              <MoreVertical size={20} />
            </button>
          )}
          {menuOpen && (
            <>
              <div
                style={{ position: "fixed", inset: 0, zIndex: 40 }}
                onClick={() => onMenuChange(null)}
              />
              <div className="card list-menu item-menu">
                {otherLists.length > 0 && (
                  <>
                    <div className="small muted" style={{ padding: "0.25rem 0.6rem" }}>
                      Move to…
                    </div>
                    {otherLists.map((l) => (
                      <button key={l.id} type="button" onClick={() => onMove(item.id, l.id)}>
                        {l.name}
                      </button>
                    ))}
                  </>
                )}
                {canRemoveItems && (
                  <>
                    {otherLists.length > 0 && (
                      <div style={{ borderTop: "1px solid var(--border)", margin: "0.25rem 0" }} />
                    )}
                    <button type="button" className="danger" onClick={() => onDelete(item.id)}>
                      Delete item
                    </button>
                  </>
                )}
              </div>
            </>
          )}
        </span>
      </div>
    );
  }

  return (
    <div key={item.id} className="row">
      <input
        type="checkbox"
        className="check"
        disabled={!canCompleteItems}
        checked={!!item.checked}
        onChange={(e) => onToggle(item.id, e.target.checked)}
      />
      <span
        className="grow"
        title={canEditItems ? "Click to edit" : undefined}
        onClick={canEditItems ? () => onStartEdit(item.id) : undefined}
        style={{
          cursor: canEditItems ? "pointer" : "default",
          textDecoration: item.checked ? "line-through" : "none",
          color: item.checked ? "var(--muted)" : undefined,
        }}
      >
        {item.text}
      </span>
    </div>
  );
}

function ListCard({
  list, canAddItems, canRemoveItems, canCompleteItems, canEditItems, canDeleteLists,
  drafts, menuFor, onMenuChange, onDraftChange, onAdd, onToggle, onDeleteItem, onDeleteList, onFullscreen,
  lists, editingItemId, itemMenuFor, onStartEdit, onUpdateItem, onMoveItem, onItemMenuChange, onCancelEdit,
}) {
  const uncheckedItems = list.items.filter((i) => !i.checked);
  const checkedItems = list.items.filter((i) => i.checked);
  const renderList = (item) => (
    <ListItem
      key={item.id}
      item={item}
      canCompleteItems={canCompleteItems}
      canEditItems={canEditItems}
      canRemoveItems={canRemoveItems}
      lists={lists}
      editing={editingItemId === item.id}
      menuOpen={itemMenuFor === item.id}
      onToggle={onToggle}
      onDelete={onDeleteItem}
      onStartEdit={onStartEdit}
      onSave={onUpdateItem}
      onCancel={onCancelEdit}
      onMove={onMoveItem}
      onMenuChange={onItemMenuChange}
    />
  );

  return (
    <div className="card">
      <div className="row" style={{ justifyContent: "space-between", marginBottom: "0.5rem" }}>
        <div className="row">
          {storeLogoUrl(list.name) && (
            <img
              className="list-logo"
              src={storeLogoUrl(list.name)}
              width={26}
              height={26}
              alt=""
              onError={(e) => { e.currentTarget.style.display = "none"; }}
            />
          )}
          <h2 style={{ margin: 0, fontSize: "1.25rem" }}>{list.name}</h2>
        </div>
        <div className="row" style={{ gap: "0.25rem" }}>
          <button
            className="icon-btn"
            onClick={onFullscreen}
            title="Show full screen"
            aria-label={`Show ${list.name} full screen`}
          >
            <Maximize size={20} />
          </button>
          {canDeleteLists && (
            <div style={{ position: "relative" }}>
              <button
                className="icon-btn"
                onClick={() => onMenuChange(menuFor === list.id ? null : list.id)}
                title="List options"
                aria-label={`Options for ${list.name}`}
              >
                <MoreVertical size={20} />
              </button>
              {menuFor === list.id && (
                <>
                  <div
                    style={{ position: "fixed", inset: 0, zIndex: 40 }}
                    onClick={() => onMenuChange(null)}
                  />
                  <div className="card list-menu">
                    <button type="button" className="danger" onClick={() => { onMenuChange(null); onDeleteList(list); }}>
                      Delete list
                    </button>
                  </div>
                </>
              )}
            </div>
          )}
        </div>
      </div>

      {uncheckedItems.length > 0 && (
        <div style={{ display: "grid", gap: "0.25rem", marginBottom: "0.5rem" }}>
          {uncheckedItems.map(renderList)}
        </div>
      )}

      {canAddItems && (
        <div className="row">
          <input
            className="grow"
            value={drafts[list.id] || ""}
            onChange={(e) => onDraftChange(list.id, e.target.value)}
            placeholder={`Add to ${list.name}…`}
          />
          <button className="primary" onClick={() => onAdd(list.id)}>Add</button>
        </div>
      )}

      {checkedItems.length > 0 && (
        <div style={{ display: "grid", gap: "0.25rem", marginTop: "0.5rem", opacity: 0.75 }}>
          {checkedItems.map(renderList)}
        </div>
      )}
    </div>
  );
}

function FullscreenList({ list, canAddItems, canRemoveItems, canCompleteItems, canEditItems, draft, onDraftChange, onAdd, onToggle, onDeleteItem, onClose, lists, editingItemId, itemMenuFor, onStartEdit, onUpdateItem, onMoveItem, onItemMenuChange, onCancelEdit }) {
  const uncheckedItems = list.items.filter((i) => !i.checked);
  const checkedItems = list.items.filter((i) => i.checked);
  const renderList = (item) => (
    <ListItem
      key={item.id}
      item={item}
      canCompleteItems={canCompleteItems}
      canEditItems={canEditItems}
      canRemoveItems={canRemoveItems}
      lists={lists}
      editing={editingItemId === item.id}
      menuOpen={itemMenuFor === item.id}
      onToggle={onToggle}
      onDelete={onDeleteItem}
      onStartEdit={onStartEdit}
      onSave={onUpdateItem}
      onCancel={onCancelEdit}
      onMove={onMoveItem}
      onMenuChange={onItemMenuChange}
    />
  );

  return (
    <div
      style={{
        position: "fixed", inset: 0, zIndex: 1100,
        background: "var(--bg)",
        display: "flex", flexDirection: "column",
      }}
    >
      <div style={{ maxWidth: 900, margin: "0 auto", width: "100%", padding: "1.5rem" }}>
        <div className="row" style={{ justifyContent: "space-between", marginBottom: 0 }}>
          <div className="row" style={{ gap: "0.75rem" }}>
            {storeLogoUrl(list.name) && (
              <img
                className="list-logo"
                src={storeLogoUrl(list.name)}
                width={40}
                height={40}
                alt=""
                onError={(e) => { e.currentTarget.style.display = "none"; }}
              />
            )}
            <h1 style={{ margin: 0 }}>{list.name}</h1>
          </div>
          <button
            className="icon-btn"
            onClick={onClose}
            title="Exit full screen"
            aria-label="Exit full screen"
          >
            <Minimize size={28} />
          </button>
        </div>
      </div>

      <div style={{ flex: 1, minHeight: 0, overflowY: "auto", background: "var(--surface)" }}>
        <div style={{ padding: "1.5rem", maxWidth: 900, margin: "0 auto" }}>
          {uncheckedItems.length > 0 && (
            <div style={{ display: "grid", gap: "0.25rem", marginBottom: "0.5rem" }}>
              {uncheckedItems.map(renderList)}
            </div>
          )}

          {canAddItems && (
            <div className="row">
              <input
                className="grow"
                value={draft}
                onChange={(e) => onDraftChange(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && onAdd(list.id)}
                placeholder={`Add to ${list.name}…`}
              />
              <button className="primary" onClick={() => onAdd(list.id)}>Add</button>
            </div>
          )}

          {checkedItems.length > 0 && (
            <div style={{ display: "grid", gap: "0.25rem", marginTop: "0.5rem", opacity: 0.75 }}>
              {checkedItems.map(renderList)}
            </div>
          )}

          {list.items.length === 0 && (
            <p className="muted" style={{ margin: 0, textAlign: "center" }}>Nothing on this list yet.</p>
          )}
        </div>
      </div>
    </div>
  );
}