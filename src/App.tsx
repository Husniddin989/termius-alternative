import { useCallback, useEffect, useState } from "react";
import { confirm, message } from "@tauri-apps/plugin-dialog";
import {
  type ForwardRule,
  forwardApi,
  forwardsApi,
  type Host,
  hostsApi,
  type Snippet,
  sftpApi,
  snippetsApi,
  SshSession,
} from "./api";
import { HostList } from "./components/HostList";
import { HostForm } from "./components/HostForm";
import { TerminalView } from "./components/TerminalView";
import { SftpView } from "./components/SftpView";
import { SnippetsView } from "./components/SnippetsView";
import { ForwardsView } from "./components/ForwardsView";
import { useConnector } from "./useConnector";
import "./App.css";

type Tab =
  | { kind: "terminal"; key: string; title: string; session: SshSession; closed: boolean }
  | { kind: "sftp"; key: string; title: string; sftpId: string; home: string };

const VIEWS = [
  { key: "hosts", label: "Hosts" },
  { key: "snippets", label: "Snippets" },
  { key: "forwards", label: "Port Forwarding" },
] as const;
type View = (typeof VIEWS)[number]["key"];

export default function App() {
  const [hosts, setHosts] = useState<Host[]>([]);
  const [snippets, setSnippets] = useState<Snippet[]>([]);
  const [rules, setRules] = useState<ForwardRule[]>([]);
  const [activeForwards, setActiveForwards] = useState<Record<string, string>>({});
  const [tabs, setTabs] = useState<Tab[]>([]);
  const [active, setActive] = useState<string>("hosts");
  const [editing, setEditing] = useState<Host | "new" | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const { connectWith, dialogs } = useConnector(hosts);

  const fail = (e: unknown) => setLoadError(String(e));
  const reloadHosts = useCallback(() => void hostsApi.list().then(setHosts, fail), []);
  const reloadSnippets = useCallback(() => void snippetsApi.list().then(setSnippets, fail), []);
  const reloadRules = useCallback(() => {
    forwardsApi.list().then(setRules, fail);
    forwardApi.active().then(setActiveForwards, fail);
  }, []);
  useEffect(() => {
    reloadHosts();
    reloadSnippets();
    reloadRules();
  }, [reloadHosts, reloadSnippets, reloadRules]);

  const saveHost = async (host: Host) => {
    await hostsApi.save(host);
    setEditing(null);
    reloadHosts();
  };

  const deleteHost = async (host: Host) => {
    const dependants = hosts.filter((h) => h.jumpHostId === host.id).map((h) => h.label);
    const note = dependants.length ? `\n\nIt is the jump host for: ${dependants.join(", ")}.` : "";
    if (!(await confirm(`Delete host "${host.label}"?${note}`, { kind: "warning" }))) return;
    await hostsApi.remove(host.id);
    reloadHosts();
  };

  const addTab = (tab: Tab) => {
    setTabs((t) => [...t, tab]);
    setActive(tab.key);
  };

  const openTerminal = async (host: Host) => {
    const session = await connectWith(host, (req) => SshSession.open(req));
    if (session) addTab({ kind: "terminal", key: session.id, title: host.label, session, closed: false });
  };

  const openSftp = async (host: Host) => {
    const opened = await connectWith(host, (req) => sftpApi.open(req));
    if (opened) addTab({ kind: "sftp", key: opened.id, title: host.label, sftpId: opened.id, home: opened.home });
  };

  const startForward = async (rule: ForwardRule) => {
    const host = hosts.find((h) => h.id === rule.hostId);
    if (!host) return;
    await connectWith(host, (req) => forwardApi.start(rule.id, req)).catch((e) =>
      message(String(e), { kind: "error" }),
    );
    reloadRules();
  };

  const stopForward = async (rule: ForwardRule) => {
    await forwardApi.stop(rule.id);
    reloadRules();
  };

  const markClosed = useCallback((key: string) => {
    setTabs((t) => t.map((tab) => (tab.key === key && tab.kind === "terminal" ? { ...tab, closed: true } : tab)));
  }, []);

  const closeTab = (key: string) => {
    const tab = tabs.find((t) => t.key === key);
    if (tab?.kind === "terminal") tab.session.close();
    if (tab?.kind === "sftp") sftpApi.close(tab.sftpId);
    const rest = tabs.filter((t) => t.key !== key);
    setTabs(rest);
    if (active === key) setActive(rest[rest.length - 1]?.key ?? "hosts");
  };

  const view = VIEWS.find((v) => v.key === active)?.key as View | undefined;

  return (
    <div className="app">
      <nav className="tabbar">
        {VIEWS.map((v) => (
          <button key={v.key} className={`tab ${active === v.key ? "active" : ""}`} onClick={() => setActive(v.key)}>
            {v.label}
          </button>
        ))}
        <span className="tab-sep" />
        {tabs.map((tab) => (
          <div
            key={tab.key}
            className={`tab ${active === tab.key ? "active" : ""} ${tab.kind === "terminal" && tab.closed ? "closed" : ""}`}
            onClick={() => setActive(tab.key)}
          >
            {tab.kind === "terminal" ? <span className="dot" /> : <span className="tab-kind">SFTP</span>}
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
        {loadError && view && <p className="error pad">{loadError}</p>}
        {view === "hosts" && (
          <HostList
            hosts={hosts}
            onAdd={() => setEditing("new")}
            onEdit={setEditing}
            onDelete={deleteHost}
            onConnect={openTerminal}
            onSftp={openSftp}
          />
        )}
        {view === "snippets" && <SnippetsView snippets={snippets} onChanged={reloadSnippets} />}
        {view === "forwards" && (
          <ForwardsView
            rules={rules}
            hosts={hosts}
            active={activeForwards}
            onStart={startForward}
            onStop={stopForward}
            onChanged={reloadRules}
          />
        )}
        {tabs.map((tab) =>
          tab.kind === "terminal" ? (
            <TerminalView
              key={tab.key}
              session={tab.session}
              active={active === tab.key}
              snippets={snippets}
              onClosed={() => markClosed(tab.key)}
            />
          ) : (
            <SftpView key={tab.key} sftpId={tab.sftpId} home={tab.home} active={active === tab.key} />
          ),
        )}
      </main>

      {editing && (
        <HostForm
          initial={editing === "new" ? undefined : editing}
          hosts={hosts}
          onSave={saveHost}
          onCancel={() => setEditing(null)}
        />
      )}
      {dialogs}
    </div>
  );
}
