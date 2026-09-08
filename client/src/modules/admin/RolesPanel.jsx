import { useCallback, useEffect, useState } from "react";
import {
  getRoles, getRoleCapabilities, createRole, updateRole, deleteRole,
} from "../../api.js";

// Manage named roles and the per-module permissions each role grants. The
// server enforces these capabilities on every request.
export default function RolesPanel({ onSaved }) {
  const [roles, setRoles] = useState([]);
  const [capCatalog, setCapCatalog] = useState([]);
  const [editing, setEditing] = useState(null);
  const [creating, setCreating] = useState(false);

  const refresh = useCallback(async () => {
    const [rs, caps] = await Promise.all([getRoles(), getRoleCapabilities()]);
    setRoles(rs);
    setCapCatalog(caps.modules);
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  function blankRole() {
    return {
      name: "",
      modules: capCatalog.map((m) => ({
        name: m.name,
        enabled: true,
        caps: Object.fromEntries(m.caps.map((c) => [c.key, true])),
      })),
    };
  }

  function startNew() {
    setEditing(blankRole());
    setCreating(true);
  }

  function startEdit(role) {
    setEditing({
      id: role.id,
      name: role.name,
      modules: capCatalog.map((m) => {
        const existing = role.modules.find((rm) => rm.name === m.name) || {};
        return {
          name: m.name,
          enabled: existing.enabled !== undefined ? existing.enabled : false,
          caps: { ...Object.fromEntries(m.caps.map((c) => [c.key, false])), ...(existing.caps || {}) },
        };
      }),
    });
    setCreating(false);
  }

  function cancel() {
    setEditing(null);
  }

  async function save() {
    if (!editing?.name.trim()) return;
    const payload = {
      name: editing.name.trim(),
      modules: editing.modules.map((m) => ({
        name: m.name,
        enabled: m.enabled,
        caps: m.caps,
      })),
    };
    if (creating) await createRole(payload);
    else await updateRole(editing.id, payload);
    setEditing(null);
    onSaved?.();
    refresh();
  }

  async function removeRole(role) {
    if (confirm(`Delete role "${role.name}"?`)) {
      await deleteRole(role.id);
      onSaved?.();
      refresh();
    }
  }

  function toggleModule(moduleName, enabled) {
    setEditing((e) => ({
      ...e,
      modules: e.modules.map((m) => (m.name === moduleName ? { ...m, enabled } : m)),
    }));
  }

  function toggleCap(moduleName, capKey, value) {
    setEditing((e) => ({
      ...e,
      modules: e.modules.map((m) =>
        m.name === moduleName ? { ...m, caps: { ...m.caps, [capKey]: value } } : m
      ),
    }));
  }

  return (
    <div style={{ display: "grid", gap: "1rem" }}>
      <div className="row">
        <div className="grow">
          <p className="small muted" style={{ margin: 0 }}>
            Each member has a role that defines the actions they can take within each
            module. Permissions are enforced on the server.
          </p>
        </div>
        <button className="primary" onClick={startNew}>+ New role</button>
      </div>

      {editing && (
        <div className="card">
          <RoleEditor
            role={editing}
            capCatalog={capCatalog}
            creating={creating}
            onChange={setEditing}
            onToggleModule={toggleModule}
            onToggleCap={toggleCap}
            onCancel={cancel}
            onSave={save}
          />
        </div>
      )}

      <div style={{ display: "grid", gap: "0.6rem" }}>
        {roles.map((role) => (
          <div key={role.id} className="card row wrap" style={{ justifyContent: "space-between" }}>
            <div>
              <strong style={{ fontSize: "1.05rem" }}>{role.name}</strong>
              <div className="small muted">
                {(role.modules || []).filter((m) => m.enabled).map((m) => m.name).join(" · ") || "No modules enabled"}
              </div>
            </div>
            <span className="row">
              <button onClick={() => startEdit(role)}>Edit</button>
              <button className="small danger" onClick={() => removeRole(role)}>✕</button>
            </span>
          </div>
        ))}
        {roles.length === 0 && <div className="card muted">No roles yet. Create one to start.</div>}
      </div>
    </div>
  );
}

function RoleEditor({ role, capCatalog, creating, onChange, onToggleModule, onToggleCap, onCancel, onSave }) {
  return (
    <div style={{ display: "grid", gap: "0.8rem" }}>
      <div className="row">
        <h3 style={{ margin: 0 }}>{creating ? "New role" : `Edit ${role.name}`}</h3>
        <input
          className="grow"
          value={role.name}
          onChange={(e) => onChange({ ...role, name: e.target.value })}
          placeholder="Role name (e.g. Older Kids)"
        />
      </div>

      {capCatalog.map((mod) => {
        const grant = role.modules.find((m) => m.name === mod.name);
        if (!grant) return null;
        return (
          <div key={mod.name} className="card" style={{ margin: 0, padding: "0.75rem" }}>
            <label className="row" style={{ justifyContent: "space-between" }}>
              <strong style={{ textTransform: "capitalize" }}>{mod.name}</strong>
              <span className="row small">
                <input
                  type="checkbox"
                  checked={grant.enabled}
                  onChange={(e) => onToggleModule(mod.name, e.target.checked)}
                />
                {grant.enabled ? "Enabled" : "Disabled"}
              </span>
            </label>

            {grant.enabled && mod.caps.length > 0 && (
              <div className="row wrap" style={{ marginTop: "0.6rem", gap: "0.4rem" }}>
                {mod.caps.map((c) => (
                  <label
                    key={c.key}
                    className="row"
                    style={{ gap: "0.3rem", border: "1px solid var(--border)", borderRadius: 8, padding: "0.3rem 0.6rem" }}
                  >
                    <input
                      type="checkbox"
                      checked={!!grant.caps[c.key]}
                      onChange={(e) => onToggleCap(mod.name, c.key, e.target.checked)}
                    />
                    {c.label}
                  </label>
                ))}
              </div>
            )}
          </div>
        );
      })}

      <div className="row">
        <button className="primary" onClick={onSave}>Save role</button>
        <button onClick={onCancel}>Cancel</button>
      </div>
    </div>
  );
}