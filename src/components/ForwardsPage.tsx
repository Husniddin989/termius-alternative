import { useEffect, useState } from "react";
import { confirm } from "@tauri-apps/plugin-dialog";
import { type ForwardKind, type ForwardRule, forwardsApi, type Host } from "../api";
import { DetailsPanel, Field, Section } from "./DetailsPanel";
import { useContextMenu } from "./ContextMenu";
import { ForwardIcon, PlayIcon, PlusIcon, StopIcon } from "./icons";

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

export function describeRule(r: ForwardRule) {
  const bind = `${r.bindHost}:${r.bindPort}`;
  return r.kind === "dynamic" ? `SOCKS5 on ${bind}` : `${bind} → ${r.destHost}:${r.destPort}`;
}

export function ForwardsPage({ rules, hosts, active, onStart, onStop, onChanged }: Props) {
  const [editing, setEditing] = useState<ForwardRule | null>(null);
  const [draft, setDraft] = useState<ForwardRule>(blank(""));
  const [busy, setBusy] = useState<string | null>(null);
  const menu = useContextMenu();
  const set = <K extends keyof ForwardRule>(k: K, v: ForwardRule[K]) => setDraft((r) => ({ ...r, [k]: v }));

  useEffect(() => {
    if (editing) setDraft(editing);
  }, [editing]);

  const save = async () => {
    const dynamic = draft.kind === "dynamic";
    const saved = await forwardsApi.save({
      ...draft,
      label: draft.label.trim() || describeRule(draft),
      destHost: dynamic ? null : draft.destHost,
      destPort: dynamic ? null : draft.destPort,
    });
    setEditing(saved);
    onChanged();
  };

  const remove = async (r: ForwardRule) => {
    if (!(await confirm(`Delete rule "${r.label}"?`, { kind: "warning" }))) return;
    await forwardsApi.remove(r.id);
    if (editing?.id === r.id) setEditing(null);
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
    <div className="with-details">
      <div className="page">
        <div className="page-head">
          <div>
            <h1>Port Forwarding</h1>
            <p className="muted">Local tunnels (-L) and SOCKS5 proxies (-D) through your hosts.</p>
          </div>
          <button className="primary" disabled={hosts.length === 0} onClick={() => setEditing(blank(hosts[0]?.id ?? ""))}>
            <PlusIcon size={16} /> New rule
          </button>
        </div>
        <div className="page-scroll">
          {hosts.length === 0 && <p className="muted">Add a host first.</p>}
          {hosts.length > 0 && rules.length === 0 && <p className="muted">No forwarding rules yet.</p>}
          <div className="cards grid wide">
            {rules.map((r) => {
              const host = hosts.find((h) => h.id === r.hostId);
              const running = active[r.id];
              return (
                <div
                  key={r.id}
                  className={`card ${editing?.id === r.id ? "selected" : ""}`}
                  onClick={() => setEditing(r)}
                  onContextMenu={(e) =>
                    menu.open(e, [
                      { label: running ? "Stop" : "Start", onClick: () => toggle(r) },
                      { label: "Edit", onClick: () => setEditing(r) },
                      { label: "Delete", onClick: () => remove(r), danger: true },
                    ])
                  }
                >
                  <span className={`tile-icon forward ${running ? "running" : ""}`}>
                    <ForwardIcon size={20} />
                  </span>
                  <div className="card-text">
                    <strong>{r.label}</strong>
                    <span>
                      {describeRule(r)} · {host?.label ?? "missing host"}
                    </span>
                  </div>
                  <button
                    className={`icon-btn play ${running ? "on" : ""}`}
                    disabled={busy === r.id || !host}
                    title={running ? `Stop (listening on ${running})` : "Start"}
                    onClick={(e) => {
                      e.stopPropagation();
                      toggle(r);
                    }}
                  >
                    {running ? <StopIcon size={14} /> : <PlayIcon size={14} />}
                  </button>
                </div>
              );
            })}
          </div>
        </div>
        {menu.element}
      </div>

      {editing && (
        <DetailsPanel
          title={editing.id ? "Edit rule" : "New rule"}
          onClose={() => setEditing(null)}
          menu={editing.id ? [{ label: "Delete", onClick: () => remove(editing), danger: true }] : []}
          footer={
            <div className="foot-buttons">
              <button className="primary wide" onClick={save} disabled={!!active[draft.id]}>
                {active[draft.id] ? "Stop the rule to edit it" : "Save"}
              </button>
            </div>
          }
        >
          <Section title="Type">
            <div className="segmented">
              {(["local", "dynamic"] as ForwardKind[]).map((k) => (
                <button key={k} className={draft.kind === k ? "on" : ""} onClick={() => set("kind", k)}>
                  {k === "local" ? "Local (-L)" : "SOCKS5 (-D)"}
                </button>
              ))}
            </div>
          </Section>
          <Section title="Through host">
            <label className="field select">
              <select value={draft.hostId} onChange={(e) => set("hostId", e.target.value)}>
                {hosts.map((h) => (
                  <option key={h.id} value={h.id}>
                    {h.label}
                  </option>
                ))}
              </select>
            </label>
          </Section>
          <Section title="Listen on this computer">
            <div className="address-row">
              <Field value={draft.bindHost} onChange={(e) => set("bindHost", e.target.value)} />
              <input className="port-input" type="number" min={1} max={65535} value={draft.bindPort} onChange={(e) => set("bindPort", Number(e.target.value))} />
            </div>
          </Section>
          {draft.kind === "local" && (
            <Section title="Destination (as seen from the host)">
              <div className="address-row">
                <Field value={draft.destHost ?? ""} onChange={(e) => set("destHost", e.target.value)} />
                <input className="port-input" type="number" min={1} max={65535} value={draft.destPort ?? ""} onChange={(e) => set("destPort", Number(e.target.value))} />
              </div>
            </Section>
          )}
          <Section title="Name">
            <Field placeholder={describeRule(draft)} value={draft.label} onChange={(e) => set("label", e.target.value)} />
          </Section>
        </DetailsPanel>
      )}
    </div>
  );
}
