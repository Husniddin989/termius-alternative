import { useEffect, useState } from "react";
import { confirm } from "@tauri-apps/plugin-dialog";
import { type Snippet, snippetsApi } from "../api";
import { DetailsPanel, Field, Section } from "./DetailsPanel";
import { useContextMenu } from "./ContextMenu";
import { PlusIcon, SnippetIcon } from "./icons";

interface Props {
  snippets: Snippet[];
  onChanged: () => void;
}

const empty: Snippet = { id: "", name: "", command: "" };

export function SnippetsPage({ snippets, onChanged }: Props) {
  const [editing, setEditing] = useState<Snippet | null>(null);
  const [draft, setDraft] = useState<Snippet>(empty);
  const menu = useContextMenu();

  useEffect(() => {
    if (editing) setDraft(editing);
  }, [editing]);

  const save = async () => {
    if (!draft.command.trim()) return;
    const saved = await snippetsApi.save({
      ...draft,
      name: draft.name.trim() || draft.command.trim().split("\n")[0].slice(0, 40),
    });
    setEditing(saved);
    onChanged();
  };

  const remove = async (s: Snippet) => {
    if (!(await confirm(`Delete snippet "${s.name}"?`, { kind: "warning" }))) return;
    await snippetsApi.remove(s.id);
    if (editing?.id === s.id) setEditing(null);
    onChanged();
  };

  return (
    <div className="with-details">
      <div className="page">
        <div className="page-head">
          <div>
            <h1>Snippets</h1>
            <p className="muted">Saved commands you can run from any terminal tab.</p>
          </div>
          <button className="primary" onClick={() => setEditing({ ...empty })}>
            <PlusIcon size={16} /> New snippet
          </button>
        </div>
        <div className="page-scroll">
          {snippets.length === 0 && <p className="muted">No snippets yet.</p>}
          <div className="cards grid">
            {snippets.map((s) => (
              <div
                key={s.id}
                className={`card ${editing?.id === s.id ? "selected" : ""}`}
                onClick={() => setEditing(s)}
                onContextMenu={(e) =>
                  menu.open(e, [
                    { label: "Edit", onClick: () => setEditing(s) },
                    { label: "Delete", onClick: () => remove(s), danger: true },
                  ])
                }
              >
                <span className="tile-icon snippet">
                  <SnippetIcon size={20} />
                </span>
                <div className="card-text">
                  <strong>{s.name}</strong>
                  <code>{s.command.split("\n")[0]}</code>
                </div>
              </div>
            ))}
          </div>
        </div>
        {menu.element}
      </div>

      {editing && (
        <DetailsPanel
          title={editing.id ? "Edit snippet" : "New snippet"}
          onClose={() => setEditing(null)}
          menu={editing.id ? [{ label: "Delete", onClick: () => remove(editing), danger: true }] : []}
          footer={
            <div className="foot-buttons">
              <button className="primary wide" onClick={save} disabled={!draft.command.trim()}>
                Save
              </button>
            </div>
          }
        >
          <Section title="Name">
            <Field placeholder="e.g. Disk usage" value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
          </Section>
          <Section title="Script">
            <textarea
              className="script"
              rows={10}
              placeholder={"df -h\nfree -m"}
              value={draft.command}
              onChange={(e) => setDraft({ ...draft, command: e.target.value })}
            />
            <p className="muted small">Each line is sent to the terminal followed by Enter.</p>
          </Section>
        </DetailsPanel>
      )}
    </div>
  );
}
