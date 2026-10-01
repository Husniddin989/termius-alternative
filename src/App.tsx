import { useCallback, useEffect, useState } from "react";
import { type Auth, type Host, hostsApi, SshSession } from "./api";
import { HostList } from "./components/HostList";
import { HostForm } from "./components/HostForm";
import { ConnectDialog } from "./components/ConnectDialog";
import { TerminalView } from "./components/TerminalView";
import "./App.css";

interface Tab {
  key: string;
  title: string;
  session: SshSession;
  closed: boolean;
}

const HOSTS_VIEW = "hosts";

export default function App() {
  const [hosts, setHosts] = useState<Host[]>([]);
  const [tabs, setTabs] = useState<Tab[]>([]);
  const [active, setActive] = useState<string>(HOSTS_VIEW);
  const [editing, setEditing] = useState<Host | "new" | null>(null);
  const [connecting, setConnecting] = useState<Host | null>(null);
  const [connectError, setConnectError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  const reload = useCallback(() => {
    hostsApi.list().then(setHosts, (e) => setLoadError(String(e)));
  }, []);
  useEffect(reload, [reload]);

  const saveHost = async (host: Host) => {
    await hostsApi.save(host);
    setEditing(null);
    reload();
  };

  const deleteHost = async (host: Host) => {
    if (!confirm(`Delete host "${host.label}"?`)) return;
    await hostsApi.remove(host.id);
    reload();
  };

  const connect = async (host: Host, auth: Auth) => {
    setBusy(true);
    setConnectError(null);
    try {
      const session = await SshSession.open(host, auth);
      const tab: Tab = { key: session.id, title: host.label, session, closed: false };
      setTabs((t) => [...t, tab]);
      setActive(tab.key);
      setConnecting(null);
    } catch (e) {
      setConnectError(String(e));
    } finally {
      setBusy(false);
    }
  };

  const markClosed = useCallback((key: string) => {
    setTabs((t) => t.map((tab) => (tab.key === key ? { ...tab, closed: true } : tab)));
  }, []);

  const closeTab = (key: string) => {
    const tab = tabs.find((t) => t.key === key);
    tab?.session.close();
    const rest = tabs.filter((t) => t.key !== key);
    setTabs(rest);
    if (active === key) setActive(rest[rest.length - 1]?.key ?? HOSTS_VIEW);
  };

  return (
    <div className="app">
      <nav className="tabbar">
        <button
          className={`tab ${active === HOSTS_VIEW ? "active" : ""}`}
          onClick={() => setActive(HOSTS_VIEW)}
        >
          ☰ Hosts
        </button>
        {tabs.map((tab) => (
          <div
            key={tab.key}
            className={`tab ${active === tab.key ? "active" : ""} ${tab.closed ? "closed" : ""}`}
            onClick={() => setActive(tab.key)}
          >
            <span className="dot" />
            {tab.title}
            <button
              className="tab-close"
              onClick={(e) => {
                e.stopPropagation();
                closeTab(tab.key);
              }}
            >
              ×
            </button>
          </div>
        ))}
      </nav>

      <main>
        {active === HOSTS_VIEW && (
          <>
            {loadError && <p className="error">{loadError}</p>}
            <HostList
              hosts={hosts}
              onAdd={() => setEditing("new")}
              onEdit={setEditing}
              onDelete={deleteHost}
              onConnect={(h) => {
                setConnectError(null);
                setConnecting(h);
              }}
            />
          </>
        )}
        {tabs.map((tab) => (
          <TerminalView
            key={tab.key}
            session={tab.session}
            active={active === tab.key}
            onClosed={() => markClosed(tab.key)}
          />
        ))}
      </main>

      {editing && (
        <HostForm
          initial={editing === "new" ? undefined : editing}
          onSave={saveHost}
          onCancel={() => setEditing(null)}
        />
      )}
      {connecting && (
        <ConnectDialog
          host={connecting}
          error={connectError}
          busy={busy}
          onConnect={(auth) => connect(connecting, auth)}
          onCancel={() => setConnecting(null)}
        />
      )}
    </div>
  );
}
