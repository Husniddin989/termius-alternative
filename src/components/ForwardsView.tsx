import { useState } from "react";
import { confirm } from "@tauri-apps/plugin-dialog";
import { type ForwardKind, type ForwardRule, forwardsApi, type Host } from "../api";

interface Props {
  rules: ForwardRule[];
  hosts: Host[];
  /** Rule id → bound address, for the rules that are running. */
  active: Record<string, string>;
  onStart: (rule: ForwardRule) => Promise<void>;
  onStop: (rule: ForwardRule) => Promise<void>;
  onChanged: () => void;
}

const blank = (hostId: string): ForwardRule => ({
  id: "",
  label: "",
  hostId,
  kind: "local",
  bindHost: "127.0.0.1",
  bindPort: 8080,
  destHost: "127.0.0.1",
  destPort: 80,
});

function describe(r: ForwardRule) {
  const bind = `${r.bindHost}:${r.bindPort}`;
  return r.kind === "dynamic" ? `SOCKS5 proxy on ${bind}` : `${bind} → ${r.destHost}:${r.destPort}`;
}

export function ForwardsView({ rules, hosts, active, onStart, onStop, onChanged }: Props) {
  const [editing, setEditing] = useState<ForwardRule | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const set = <K extends keyof ForwardRule>(k: K, v: ForwardRule[K]) =>
    setEditing((r) => (r ? { ...r, [k]: v } : r));

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!editing) return;
    const dynamic = editing.kind === "dynamic";
    await forwardsApi.save({
      ...editing,
      label: editing.label.trim() || describe(editing),
      destHost: dynamic ? null : editing.destHost,
      destPort: dynamic ? null : editing.destPort,
    });
    setEditing(null);
    onChanged();
  };

  const remove = async (r: ForwardRule) => {
    if (!(await confirm(`Delete forwarding rule "${r.label}"?`, { kind: "warning" }))) return;
    await forwardsApi.remove(r.id);
    onChanged();
  };

  const toggle = async (r: ForwardRule) => {
    setBusy(r.id);
    try {
      await (active[r.id] ? onStop(r) : onStart(r));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="page">
      <div className="page-toolbar">
        <div>
          <h2>Port forwarding</h2>
          <p className="muted">Local (-L) tunnels and dynamic SOCKS5 proxies (-D) through your hosts.</p>
        </div>
        <button disabled={hosts.length === 0} onClick={() => setEditing(blank(hosts[0]?.id ?? ""))}>
          + New rule
        </button>
      </div>

      {hosts.length === 0 && <p className="empty">Add a host first.</p>}
      {hosts.length > 0 && rules.length === 0 && <p className="empty">No forwarding rules yet.</p>}
      <div className="list">
        {rules.map((r) => {
          const host = hosts.find((h) => h.id === r.hostId);
          const running = active[r.id];
          return (
            <div key={r.id} className="list-item">
              <span className={`status-dot ${running ? "on" : ""}`} />
              <div className="grow">
                <strong>{r.label}</strong>
                <span className="muted">
                  {describe(r)} · via {host?.label ?? "missing host"}
                  {running && ` · listening on ${running}`}
                </span>
              </div>
              <button className={running ? "ghost" : ""} disabled={busy === r.id || !host} onClick={() => toggle(r)}>
                {busy === r.id ? "…" : running ? "Stop" : "Start"}
              </button>
              <button className="ghost" disabled={!!running} onClick={() => setEditing(r)}>
                Edit
              </button>
              <button className="ghost danger" onClick={() => remove(r)}>
                Delete
              </button>
            </div>
          );
        })}
      </div>

      {editing && (
        <div className="modal-backdrop" onClick={() => setEditing(null)}>
          <form className="modal" onClick={(e) => e.stopPropagation()} onSubmit={save}>
            <h2>{editing.id ? "Edit rule" : "New forwarding rule"}</h2>
            <label>
              Label
              <input value={editing.label} onChange={(e) => set("label", e.target.value)} placeholder="Postgres tunnel" />
            </label>
            <div className="row">
              <label className="grow">
                Host
                <select value={editing.hostId} onChange={(e) => set("hostId", e.target.value)}>
                  {hosts.map((h) => (
                    <option key={h.id} value={h.id}>
                      {h.label}
                    </option>
                  ))}
                </select>
              </label>
              <label className="grow">
                Type
                <select value={editing.kind} onChange={(e) => set("kind", e.target.value as ForwardKind)}>
                  <option value="local">Local (-L)</option>
                  <option value="dynamic">Dynamic SOCKS5 (-D)</option>
                </select>
              </label>
            </div>
            <div className="row">
              <label className="grow">
                Bind address
                <input required value={editing.bindHost} onChange={(e) => set("bindHost", e.target.value)} />
              </label>
              <label className="port">
                Local port
                <input type="number" min={1} max={65535} required value={editing.bindPort} onChange={(e) => set("bindPort", Number(e.target.value))} />
              </label>
            </div>
            {editing.kind === "local" && (
              <div className="row">
                <label className="grow">
                  Destination host (as seen from the server)
                  <input required value={editing.destHost ?? ""} onChange={(e) => set("destHost", e.target.value)} />
                </label>
                <label className="port">
                  Port
                  <input type="number" min={1} max={65535} required value={editing.destPort ?? ""} onChange={(e) => set("destPort", Number(e.target.value))} />
                </label>
              </div>
            )}
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
