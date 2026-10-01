import { useMemo, useState } from "react";
import type { Host } from "../api";

interface Props {
  hosts: Host[];
  onConnect: (host: Host) => void;
  onSftp: (host: Host) => void;
  onEdit: (host: Host) => void;
  onDelete: (host: Host) => void;
  onAdd: () => void;
}

export function HostList({ hosts, onConnect, onSftp, onEdit, onDelete, onAdd }: Props) {
  const [query, setQuery] = useState("");

  const groups = useMemo(() => {
    const q = query.toLowerCase();
    const filtered = hosts.filter((h) =>
      [h.label, h.host, h.username, h.group ?? ""].some((v) => v.toLowerCase().includes(q)),
    );
    const byGroup = new Map<string, Host[]>();
    for (const h of filtered) {
      const g = h.group || "Ungrouped";
      byGroup.set(g, [...(byGroup.get(g) ?? []), h]);
    }
    return [...byGroup.entries()].sort(([a], [b]) => a.localeCompare(b));
  }, [hosts, query]);

  return (
    <div className="hosts">
      <div className="hosts-toolbar">
        <input
          className="search"
          placeholder="Search hosts…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <button onClick={onAdd}>+ New host</button>
      </div>

      {hosts.length === 0 && (
        <div className="empty">
          <p>No hosts yet.</p>
          <button onClick={onAdd}>Add your first host</button>
        </div>
      )}

      {groups.map(([group, items]) => (
        <section key={group}>
          <h3>{group}</h3>
          <div className="host-grid">
            {items.map((h) => (
              <div key={h.id} className="host-card" onClick={() => onConnect(h)} title="Click to connect">
                <div className="host-icon">{h.label.slice(0, 1).toUpperCase()}</div>
                <div className="host-info">
                  <strong>{h.label}</strong>
                  <span className="muted">
                    {h.username}@{h.host}
                    {h.port !== 22 && `:${h.port}`}
                    {h.jumpHostId && ` · via ${hosts.find((j) => j.id === h.jumpHostId)?.label ?? "?"}`}
                  </span>
                </div>
                <div className="host-actions">
                  <button
                    className="ghost"
                    onClick={(e) => {
                      e.stopPropagation();
                      onSftp(h);
                    }}
                    title="Open SFTP"
                  >
                    SFTP
                  </button>
                  <button
                    className="ghost"
                    onClick={(e) => {
                      e.stopPropagation();
                      onEdit(h);
                    }}
                    title="Edit"
                  >
                    ✎
                  </button>
                  <button
                    className="ghost danger"
                    onClick={(e) => {
                      e.stopPropagation();
                      onDelete(h);
                    }}
                    title="Delete"
                  >
                    ✕
                  </button>
                </div>
              </div>
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}
