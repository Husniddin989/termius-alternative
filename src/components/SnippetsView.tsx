import { useState } from "react";
import { confirm } from "@tauri-apps/plugin-dialog";
import { type Snippet, snippetsApi } from "../api";

interface Props {
  snippets: Snippet[];
  onChanged: () => void;
}

const empty: Snippet = { id: "", name: "", command: "" };

export function SnippetsView({ snippets, onChanged }: Props) {
  const [editing, setEditing] = useState<Snippet | null>(null);

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!editing) return;
    await snippetsApi.save({ ...editing, name: editing.name.trim() || editing.command.split("\n")[0] });
    setEditing(null);
    onChanged();
  };

  const remove = async (s: Snippet) => {
    if (!(await confirm(`Delete snippet "${s.name}"?`, { kind: "warning" }))) return;
    await snippetsApi.remove(s.id);
    onChanged();
  };

  return (
    <div className="page">
      <div className="page-toolbar">
        <div>
          <h2>Snippets</h2>
          <p className="muted">Saved commands. Run them from the ⚡ button in any terminal tab.</p>
        </div>
        <button onClick={() => setEditing(empty)}>+ New snippet</button>
      </div>

      {snippets.length === 0 && <p className="empty">No snippets yet.</p>}
      <div className="list">
        {snippets.map((s) => (
          <div key={s.id} className="list-item">
            <div className="grow">
              <strong>{s.name}</strong>
              <pre className="command">{s.command}</pre>
            </div>
            <button className="ghost" onClick={() => setEditing(s)}>
              Edit
            </button>
            <button className="ghost danger" onClick={() => remove(s)}>
              Delete
            </button>
          </div>
        ))}
      </div>

      {editing && (
        <div className="modal-backdrop" onClick={() => setEditing(null)}>
          <form className="modal" onClick={(e) => e.stopPropagation()} onSubmit={save}>
            <h2>{editing.id ? "Edit snippet" : "New snippet"}</h2>
            <label>
              Name
              <input value={editing.name} onChange={(e) => setEditing({ ...editing, name: e.target.value })} placeholder="Disk usage" />
            </label>
            <label>
              Command
              <textarea
                required
                rows={5}
                value={editing.command}
                onChange={(e) => setEditing({ ...editing, command: e.target.value })}
                placeholder="df -h"
              />
            </label>
            <div className="actions">
              <button type="button" className="ghost" onClick={() => setEditing(null)}>
                Cancel
              </button>
              <button type="submit">Save</button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
}
