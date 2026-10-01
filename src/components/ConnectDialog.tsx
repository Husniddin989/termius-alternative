import { useState } from "react";
import type { Auth, Host } from "../api";

interface Props {
  host: Host;
  error: string | null;
  busy: boolean;
  onConnect: (auth: Auth) => void;
  onCancel: () => void;
}

/** Asks for the secret (password or key passphrase), which is never stored. */
export function ConnectDialog({ host, error, busy, onConnect, onCancel }: Props) {
  const [secret, setSecret] = useState("");
  const isKey = host.authMethod === "key";

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    onConnect(
      isKey
        ? { kind: "key", keyPath: host.keyPath ?? "", passphrase: secret || null }
        : { kind: "password", password: secret },
    );
  };

  return (
    <div className="modal-backdrop" onClick={onCancel}>
      <form className="modal" onClick={(e) => e.stopPropagation()} onSubmit={submit}>
        <h2>Connect to {host.label}</h2>
        <p className="muted">
          {host.username}@{host.host}:{host.port}
        </p>
        <label>
          {isKey ? "Key passphrase (leave empty if none)" : "Password"}
          <input type="password" autoFocus value={secret} onChange={(e) => setSecret(e.target.value)} />
        </label>
        {error && <p className="error">{error}</p>}
        <div className="actions">
          <button type="button" className="ghost" onClick={onCancel}>
            Cancel
          </button>
          <button type="submit" disabled={busy}>
            {busy ? "Connecting…" : "Connect"}
          </button>
        </div>
      </form>
    </div>
  );
}
