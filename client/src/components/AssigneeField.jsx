import Avatar from "./Avatar.jsx";

// Multi-user "tag field": shows a chip per selected member plus a dropdown to
// add more. Used in the task form and on task rows.
export default function AssigneeField({ value, members, onChange, addLabel = "+ assign" }) {
  const byId = new Map(members.map((m) => [m.id, m]));
  const ids = value || [];

  function add(id) {
    const n = Number(id);
    if (n && !ids.includes(n)) onChange([...ids, n]);
  }
  function remove(id) {
    onChange(ids.filter((v) => v !== id));
  }

  const available = members.filter((m) => !ids.includes(m.id));

  return (
    <div className="row wrap" style={{ gap: "0.35rem" }}>
      {ids.map((id) => {
        const m = byId.get(id);
        if (!m) return null;
        return (
          <span key={id} className="chip" title={m.name}>
            <Avatar user={m} size="sm" />
            {m.name}
            <button type="button" className="chip-x" onClick={() => remove(id)}>✕</button>
          </span>
        );
      })}

      {available.length > 0 ? (
        <select
          value=""
          onChange={(e) => add(e.target.value)}
          className="assign-add"
          title="Add assignee"
        >
          <option value="">{addLabel}…</option>
          {available.map((m) => (
            <option key={m.id} value={m.id}>{m.name}</option>
          ))}
        </select>
      ) : null}
    </div>
  );
}