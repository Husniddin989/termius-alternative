import { useState } from "react";
import type { AuthMethod, Host } from "../api";

interface Props {
  initial?: Host;
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
};

export function HostForm({ initial, onSave, onCancel }: Props) {
  const [host, setHost] = useState<Host>(initial ?? empty);
  const set = <K extends keyof Host>(key: K, value: Host[K]) =>
    setHost((h) => ({ ...h, [key]: value }));

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    onSave({
      ...host,
      label: host.label.trim() || host.host,
      group: host.group?.trim() || null,
      keyPath: host.authMethod === "key" ? host.keyPath : null,
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
        <label>
          Username
          <input required value={host.username} onChange={(e) => set("username", e.target.value)} />
        </label>
        <label>
          Group
          <input value={host.group ?? ""} onChange={(e) => set("group", e.target.value)} placeholder="optional" />
        </label>
        <label>
          Authentication
          <select value={host.authMethod} onChange={(e) => set("authMethod", e.target.value as AuthMethod)}>
            <option value="password">Password</option>
            <option value="key">Private key</option>
          </select>
        </label>
        {host.authMethod === "key" && (
          <label>
            Private key path
            <input required value={host.keyPath ?? ""} onChange={(e) => set("keyPath", e.target.value)} />
          </label>
        )}
        <div className="actions">
          <button type="button" className="ghost" onClick={onCancel}>
            Cancel
          </button>
          <button type="submit">Save</button>
        </div>
      </form>
    </div>
  );
}
