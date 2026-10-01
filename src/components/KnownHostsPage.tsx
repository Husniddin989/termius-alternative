import { useCallback, useEffect, useState } from "react";
import { confirm } from "@tauri-apps/plugin-dialog";
import { type KnownHost, knownHostsApi } from "../api";
import { FingerprintIcon, TrashIcon } from "./icons";

export function KnownHostsPage({ active }: { active: boolean }) {
  const [entries, setEntries] = useState<KnownHost[]>([]);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    knownHostsApi.list().then(setEntries, (e) => setError(String(e)));
  }, []);
  useEffect(() => {
    if (active) load();
  }, [active, load]);

  const forget = async (k: KnownHost) => {
    const ok = await confirm(
      `Forget the key of ${k.host}? You will be asked to verify its fingerprint on the next connection.`,
      { kind: "warning" },
    );
    if (!ok) return;
    await knownHostsApi.remove(k.line);
    load();
  };

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>Known Hosts</h1>
          <p className="muted">
            Server keys you have trusted. Forget one when a server was reinstalled and its key legitimately changed.
          </p>
        </div>
      </div>
      <div className="page-scroll">
        {error && <p className="error">{error}</p>}
        {entries.length === 0 && !error && <p className="muted">No trusted keys yet.</p>}
        <div className="cards list">
          {entries.map((k) => (
            <div key={`${k.line}-${k.host}`} className="card">
              <span className="tile-icon key">
                <FingerprintIcon size={20} />
              </span>
              <div className="card-text">
                <strong>{k.host}</strong>
                <code>
                  {k.algorithm} · {k.fingerprint}
                </code>
              </div>
              <button className="icon-btn danger" onClick={() => forget(k)} title="Forget">
                <TrashIcon size={16} />
              </button>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
