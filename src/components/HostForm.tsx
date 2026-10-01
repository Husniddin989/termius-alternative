import { useState } from "react";
import { type AuthMethod, type Host, secretsApi } from "../api";

interface Props {
  initial?: Host;
  hosts: Host[];
  onSave: (host: Host) => void;
  onCancel: () => void;
}

const empty: Host = {
  id: "",
  label: "",
  host: "",
  port: 22,
  username: "root",
  authMethod: "password",
  keyPath: "~/.ssh/id_ed25519",
  group: "",
  jumpHostId: null,
};

export function HostForm({ initial, hosts, onSave, onCancel }: Props) {
  const [host, setHost] = useState<Host>(initial ?? empty);
  const [forgotten, setForgotten] = useState(false);
  const set = <K extends keyof Host>(key: K, value: Host[K]) =>
    setHost((h) => ({ ...h, [key]: value }));

  // A host cannot jump through itself or through a host that jumps through it.
  const jumpCandidates = hosts.filter((h) => h.id !== host.id && h.jumpHostId !== host.id);

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    onSave({
      ...host,
      label: host.label.trim() || host.host,
      group: host.group?.trim() || null,
      keyPath: host.authMethod === "key" ? host.keyPath : null,
      jumpHostId: host.jumpHostId || null,
    });
  };

  return (
    <div className="modal-backdrop" onClick={onCancel}>
      <form className="modal" onClick={(e) => e.stopPropagation()} onSubmit={submit}>
        <h2>{initial ? "Edit host" : "New host"}</h2>
        <label>
          Label
          <input value={host.label} onChange={(e) => set("label", e.target.value)} placeholder="Production web" />
        </label>
        <div className="row">
          <label className="grow">
            Address
            <input required value={host.host} onChange={(e) => set("host", e.target.value)} placeholder="192.168.1.10" />
          </label>
          <label className="port">
            Port
            <input
              type="number"
              min={1}
              max={65535}
              required
              value={host.port}
              onChange={(e) => set("port", Number(e.target.value))}
            />
          </label>
        </div>
        <div className="row">
          <label className="grow">
            Username
            <input required value={host.username} onChange={(e) => set("username", e.target.value)} />
          </label>
          <label className="grow">
            Group
            <input value={host.group ?? ""} onChange={(e) => set("group", e.target.value)} placeholder="optional" />
          </label>
        </div>
        <label>
          Authentication
          <select value={host.authMethod} onChange={(e) => set("authMethod", e.target.value as AuthMethod)}>
            <option value="password">Password</option>
            <option value="key">Private key</option>
            <option value="agent">SSH agent</option>
          </select>
        </label>
        {host.authMethod === "key" && (
          <label>
            Private key path
            <input required value={host.keyPath ?? ""} onChange={(e) => set("keyPath", e.target.value)} />
          </label>
        )}
        <label>
          Jump host
          <select value={host.jumpHostId ?? ""} onChange={(e) => set("jumpHostId", e.target.value || null)}>
            <option value="">None (direct connection)</option>
            {jumpCandidates.map((h) => (
              <option key={h.id} value={h.id}>
                {h.label} ({h.username}@{h.host})
              </option>
            ))}
          </select>
        </label>
        <div className="actions">
          {initial && initial.authMethod !== "agent" && (
            <button
              type="button"
              className="ghost left"
              disabled={forgotten}
              onClick={() => secretsApi.remove(initial.id).then(() => setForgotten(true))}
            >
              {forgotten ? "Saved secret removed" : "Forget saved secret"}
            </button>
          )}
          <button type="button" className="ghost" onClick={onCancel}>
            Cancel
          </button>
          <button type="submit">Save</button>
        </div>
      </form>
    </div>
  );
}
