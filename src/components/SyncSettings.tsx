import { useEffect, useState } from "react";
import { confirm } from "@tauri-apps/plugin-dialog";
import { openUrl } from "@tauri-apps/plugin-opener";
import type { SyncControl } from "../useSync";
import { Field } from "./DetailsPanel";
import { EyeIcon, EyeOffIcon, KeyIcon, LockIcon, RefreshIcon } from "./icons";

const TOKEN_URL = "https://github.com/settings/tokens/new?scopes=gist&description=Termius%20Alternative%20sync";

function ago(at: number) {
  const s = Math.max(0, Math.round((Date.now() - at) / 1000));
  if (s < 45) return "just now";
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return new Date(at).toLocaleString();
}

export function SyncSettings({ sync, onNote }: { sync: SyncControl; onNote: (text: string) => void }) {
  const { status, syncing } = sync;
  const [token, setToken] = useState("");
  const [passphrase, setPassphrase] = useState("");
  const [show, setShow] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [, tick] = useState(0);

  // Keep "synced 2 min ago" current.
  useEffect(() => {
    const t = window.setInterval(() => tick((n) => n + 1), 30_000);
    return () => window.clearInterval(t);
  }, []);

  const setup = async () => {
    setBusy(true);
    setError(null);
    try {
      const report = await sync.setup(token, passphrase);
      setToken("");
      setPassphrase("");
      onNote(`Sync is on — ${report.hosts} host${report.hosts === 1 ? "" : "s"} in your vault.`);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  const disable = async () => {
    const ok = await confirm(
      "Stop syncing on this device? Your hosts stay here and in the encrypted vault on GitHub.",
      { kind: "warning", okLabel: "Turn off" },
    );
    if (!ok) return;
    await sync.disable();
  };

  if (status?.enabled) {
    return (
      <section className="settings-card">
        <h2>Sync</h2>
        <p className="muted">
          Hosts, saved passwords, snippets and port forwarding rules are synced end-to-end encrypted through a secret
          gist in <b>@{status.login}</b>. Only devices with your sync password can read them.
        </p>
        <div className="sync-state">
          <span className={`dot ${status.lastError ? "bad" : syncing ? "busy" : "ok"}`} />
          {syncing
            ? "Syncing…"
            : status.lastError
              ? status.lastError
              : status.lastSync
                ? `Synced ${ago(status.lastSync)}`
                : "Not synced yet"}
        </div>
        <div className="setting-row">
          <button className="primary" disabled={syncing} onClick={() => sync.syncNow()}>
            <RefreshIcon size={15} /> Sync now
          </button>
          <button className="secondary" onClick={disable}>
            Turn off
          </button>
        </div>
        <p className="muted small">
          Key files are not synced: for key-based hosts, put the key on each device at the same path (or switch the
          host to password login).
        </p>
      </section>
    );
  }

  return (
    <section className="settings-card">
      <h2>Sync</h2>
      <p className="muted">
        Have the same hosts and passwords on your computer and phone. Everything is encrypted on the device with your
        sync password and stored in a secret gist in your GitHub account — GitHub never sees the contents.
      </p>
      <ol className="steps muted small">
        <li>
          Create a GitHub token with only the <b>gist</b> permission:{" "}
          <button className="link" onClick={() => openUrl(TOKEN_URL)}>
            open GitHub
          </button>
        </li>
        <li>Paste it below and choose a sync password. Use the same token account and password on every device.</li>
      </ol>
      <Field
        icon={<KeyIcon size={15} />}
        type="password"
        placeholder="GitHub token (ghp_… or github_pat_…)"
        value={token}
        autoComplete="off"
        onChange={(e) => setToken(e.target.value)}
      />
      <Field
        icon={<LockIcon size={15} />}
        type={show ? "text" : "password"}
        placeholder="Sync password (8+ characters)"
        value={passphrase}
        autoComplete="new-password"
        onChange={(e) => setPassphrase(e.target.value)}
        onKeyDown={(e) => e.key === "Enter" && token.trim() && passphrase.length >= 8 && !busy && setup()}
        trailing={
          <button type="button" className="icon-btn" onClick={() => setShow((s) => !s)} title="Show">
            {show ? <EyeOffIcon size={15} /> : <EyeIcon size={15} />}
          </button>
        }
      />
      {error && <p className="error small">{error}</p>}
      <div>
        <button className="primary" disabled={busy || !token.trim() || passphrase.length < 8} onClick={setup}>
          {busy ? "Connecting…" : "Turn on sync"}
        </button>
      </div>
      <p className="muted small">
        The sync password can't be recovered — if you forget it, delete the gist on GitHub and set up sync again.
      </p>
    </section>
  );
}
