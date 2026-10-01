import { useEffect, useMemo, useState } from "react";
import { confirm } from "@tauri-apps/plugin-dialog";
import { type Snippet, snippetsApi } from "../api";
import { DetailsPanel, Field, Section } from "./DetailsPanel";
import { useContextMenu } from "./ContextMenu";
import { PlusIcon, SearchIcon, SnippetIcon } from "./icons";
import { hasPlaceholder } from "../snippetLibrary";

interface Props {
  snippets: Snippet[];
  onChanged: () => void;
}

const empty: Snippet = { id: "", name: "", command: "", category: null };
const UNCATEGORIZED = "My snippets";

export function SnippetsPage({ snippets, onChanged }: Props) {
  const [editing, setEditing] = useState<Snippet | null>(null);
  const [draft, setDraft] = useState<Snippet>(empty);
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState<string | null>(null);
  const menu = useContextMenu();

  useEffect(() => {
    if (editing) setDraft(editing);
  }, [editing]);

  const categories = useMemo(
    () => [...new Set(snippets.map((s) => s.category || UNCATEGORIZED))].sort((a, b) =>
      a === UNCATEGORIZED ? -1 : b === UNCATEGORIZED ? 1 : a.localeCompare(b),
    ),
    [snippets],
  );

  const groups = useMemo(() => {
    const q = query.trim().toLowerCase();
    const visible = snippets.filter(
      (s) =>
        (!category || (s.category || UNCATEGORIZED) === category) &&
        (!q || [s.name, s.command, s.category ?? ""].some((v) => v.toLowerCase().includes(q))),
    );
    return categories
      .map((c) => [c, visible.filter((s) => (s.category || UNCATEGORIZED) === c)] as const)
      .filter(([, items]) => items.length > 0);
  }, [snippets, categories, query, category]);

  const save = async () => {
    if (!draft.command.trim()) return;
    const saved = await snippetsApi.save({
      ...draft,
      name: draft.name.trim() || draft.command.trim().split("\n")[0].slice(0, 40),
      category: draft.category?.trim() || null,
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
        <div className="filters">
          <label className="field search">
            <span className="field-icon">
              <SearchIcon size={15} />
            </span>
            <input placeholder="Search snippets" value={query} onChange={(e) => setQuery(e.target.value)} />
          </label>
          <div className="chips">
            <button className={`chip ${category === null ? "on" : ""}`} onClick={() => setCategory(null)}>
              All
            </button>
            {categories.map((c) => (
              <button key={c} className={`chip ${category === c ? "on" : ""}`} onClick={() => setCategory(c)}>
                {c}
              </button>
            ))}
          </div>
        </div>
        <div className="page-scroll">
          {snippets.length === 0 && <p className="muted">No snippets yet. Add the built-in library from Settings.</p>}
          {snippets.length > 0 && groups.length === 0 && <p className="muted">No snippets match.</p>}
          {groups.map(([name, items]) => (
            <section key={name}>
              <h2 className="section-title">{name}</h2>
              <div className="cards grid wide">
                {items.map((s) => (
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
            </section>
          ))}
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
          <Section title="Category">
            <Field
              placeholder={UNCATEGORIZED}
              list="snippet-categories"
              value={draft.category ?? ""}
              onChange={(e) => setDraft({ ...draft, category: e.target.value })}
            />
            <datalist id="snippet-categories">
              {categories.filter((c) => c !== UNCATEGORIZED).map((c) => (
                <option key={c} value={c} />
              ))}
            </datalist>
          </Section>
          <Section title="Script">
            <textarea
              className="script"
              rows={10}
              placeholder={"df -h\nfree -m"}
              value={draft.command}
              onChange={(e) => setDraft({ ...draft, command: e.target.value })}
            />
            <p className="muted small">
              {hasPlaceholder(draft.command)
                ? "Contains <placeholders>: it is typed into the terminal without Enter so you can fill them in."
                : "Each line is sent to the terminal followed by Enter."}
            </p>
          </Section>
        </DetailsPanel>
      )}
    </div>
  );
}
