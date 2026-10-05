import { useMemo, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { type Host, type ImportedHost, importApi } from "../api";
import { CloseIcon, FileIcon, KeyIcon, LockIcon } from "./icons";

interface Props {
  hosts: Host[];
  onClose: () => void;
  /** Called after hosts were saved. */
  onImported: (added: number) => void;
}

const sameTarget = (h: Host, i: ImportedHost) =>
  h.host.toLowerCase() === i.host.toLowerCase() && h.port === i.port && h.username === (i.username || "root");

/**
 * Imports hosts from an OpenSSH config (~/.ssh/config, or what
 * `termius export-ssh-config` writes) or a CSV such as Termius' template.
 */
export function ImportDialog({ hosts, onClose, onImported }: Props) {
  const [items, setItems] = useState<ImportedHost[] | null>(null);
  const [source, setSource] = useState("");
  const [picked, setPicked] = useState<Set<number>>(new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const existing = useMemo(
    () => new Set((items ?? []).flatMap((it, i) => (hosts.some((h) => sameTarget(h, it)) ? [i] : []))),
    [items, hosts],
  );

  const load = async (path: string | null) => {
    setBusy(true);
    setError(null);
    try {
      const found = await importApi.preview(path);
      setItems(found);
      setSource(path ?? "~/.ssh/config");
      setPicked(new Set(found.flatMap((it, i) => (hosts.some((h) => sameTarget(h, it)) ? [] : [i]))));
      if (found.length === 0) setError("No hosts found in this file.");
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  const chooseFile = async () => {
    const path = await open({ multiple: false, directory: false, title: "Choose an SSH config or CSV file" });
    if (typeof path === "string") await load(path);
  };

  const toggle = (i: number) =>
    setPicked((p) => {
      const next = new Set(p);
      if (next.has(i)) next.delete(i);
      else next.add(i);
      return next;
    });

  const selectable = (items ?? []).map((_, i) => i).filter((i) => !existing.has(i));
  const allPicked = selectable.length > 0 && selectable.every((i) => picked.has(i));

  const save = async () => {
    if (!items) return;
    setBusy(true);
    setError(null);
    try {
      const result = await importApi.save(items.filter((_, i) => picked.has(i)));
      onImported(result.added);
      onClose();
    } catch (e) {
      setError(String(e));
      setBusy(false);
    }
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal import-modal" onClick={(e) => e.stopPropagation()}>
        <header className="import-head">
          <h2>Import hosts</h2>
          <button className="icon-btn" onClick={onClose} title="Close">
            <CloseIcon size={16} />
          </button>
        </header>

        {!items ? (
          <>
            <p className="muted">
              Bring your servers over from Termius or any other SSH client. Passwords and keys in the file are saved
              to the keychain.
            </p>
            <div className="import-sources">
              <button className="import-source" disabled={busy} onClick={chooseFile}>
                <FileIcon size={20} />
                <span>
                  <strong>Choose a file…</strong>
                  <span className="muted small block">CSV, SSH config or a Termius export</span>
                </span>
              </button>
              <button className="import-source" disabled={busy} onClick={() => load(null)}>
                <KeyIcon size={20} />
                <span>
                  <strong>~/.ssh/config</strong>
                  <span className="muted small block">Hosts you use with the ssh command</span>
                </span>
              </button>
            </div>
            <details className="import-help">
              <summary>How do I get my hosts out of Termius?</summary>
              <p className="muted small">
                Termius has no export button, but its command-line tool can write all your hosts to an SSH config
                file:
              </p>
              <pre>
                {`brew install termius        # or: pip install termius
termius login
termius pull
termius export-ssh-config    # writes ./termius/sshconfig`}
              </pre>
              <p className="muted small">
                Then choose <code>termius/sshconfig</code> here. If that doesn't work for your account, list your hosts
                in a spreadsheet with the columns <code>Label, Hostname/IP, Port, Username, Password, Groups</code>,
                save it as CSV and import that.
              </p>
            </details>
          </>
        ) : (
          <>
            <p className="muted small">
              {items.length} host{items.length === 1 ? "" : "s"} in <code>{source}</code>
              {existing.size > 0 && ` · ${existing.size} already saved`}
            </p>
            {items.length > 0 && !items.some((it) => it.password) && (
              <p className="muted small">
                SSH config files don't contain passwords — you'll be asked once on the first connect, and it's saved.
              </p>
            )}
            {items.length > 0 && (
              <label className="check select-all">
                <input
                  type="checkbox"
                  checked={allPicked}
                  onChange={() => setPicked(allPicked ? new Set() : new Set(selectable))}
                />
                Select all
              </label>
            )}
            <div className="import-list">
              {items.map((it, i) => {
                const dup = existing.has(i);
                return (
                  <label key={i} className={`import-row ${dup ? "dup" : ""}`}>
                    <input type="checkbox" disabled={dup} checked={picked.has(i)} onChange={() => toggle(i)} />
                    <span className="import-main">
                      <strong>{it.label}</strong>
                      <span className="muted small">
                        {it.username || "root"}@{it.host}
                        {it.port !== 22 ? `:${it.port}` : ""}
                        {it.jump ? ` · via ${it.jump}` : ""}
                      </span>
                    </span>
                    <span className="import-tags">
                      {it.group && <span className="tag">{it.group}</span>}
                      {(it.keyPath || it.keyText) && (
                        <span className="tag" title={it.keyPath ?? "Private key included"}>
                          <KeyIcon size={12} /> key
                        </span>
                      )}
                      {it.password && (
                        <span className="tag">
                          <LockIcon size={12} /> password
                        </span>
                      )}
                      {dup && <span className="tag muted">already saved</span>}
                    </span>
                  </label>
                );
              })}
            </div>
          </>
        )}

        {error && <p className="error small">{error}</p>}
        <div className="actions">
          {items && (
            <button className="secondary" onClick={() => setItems(null)} disabled={busy}>
              Back
            </button>
          )}
          {items ? (
            <button className="primary" onClick={save} disabled={busy || picked.size === 0}>
              {busy ? "Importing…" : `Import ${picked.size} host${picked.size === 1 ? "" : "s"}`}
            </button>
          ) : (
            <button className="secondary" onClick={onClose}>
              Cancel
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
