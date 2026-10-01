import { useState } from "react";
import type { Auth, Host } from "../api";

export interface Credentials {
  auth: Auth;
  /** Secret to store in the keychain once the connection succeeds, if any. */
  save: string | null;
}

interface Props {
  host: Host;
  error: string | null;
  onSubmit: (c: Credentials) => void;
  onCancel: () => void;
}

/** Asks for the password or key passphrase of a host. */
export function ConnectDialog({ host, error, onSubmit, onCancel }: Props) {
  const [secret, setSecret] = useState("");
  const [remember, setRemember] = useState(true);
  const method = host.authMethod;

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const auth: Auth =
      method === "agent"
        ? { kind: "agent" }
        : method === "key"
          ? { kind: "key", keyPath: host.keyPath ?? "", passphrase: secret || null }
          : { kind: "password", password: secret };
    onSubmit({ auth, save: remember && method !== "agent" ? secret : null });
  };

  return (
    <div className="modal-backdrop" onClick={onCancel}>
      <form className="modal" onClick={(e) => e.stopPropagation()} onSubmit={submit}>
        <h2>Connect to {host.label}</h2>
        <p className="muted">
          {host.username}@{host.host}:{host.port}
        </p>
        {method === "agent" ? (
          <p className="muted">Authenticating with the keys in your SSH agent.</p>
        ) : (
          <>
            <label>
              {method === "key" ? "Key passphrase (leave empty if none)" : "Password"}
              <input type="password" autoFocus value={secret} onChange={(e) => setSecret(e.target.value)} />
            </label>
            {host.id && (
              <label className="check">
                <input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} />
                Save in system keychain
              </label>
            )}
          </>
        )}
        {error && <p className="error">{error}</p>}
        <div className="actions">
          <button type="button" className="secondary" onClick={onCancel}>
            Cancel
          </button>
          <button type="submit" className="primary" autoFocus={method === "agent"}>
            {error ? "Retry" : "Connect"}
          </button>
        </div>
      </form>
    </div>
  );
}
