import { useCallback, useEffect, useState } from "react";
import { confirm, message } from "@tauri-apps/plugin-dialog";
import {
  type ForwardRule,
  forwardApi,
  forwardsApi,
  type Host,
  hostsApi,
  secretsApi,
  type Settings,
  settingsApi,
  type Snippet,
  snippetsApi,
  SshSession,
} from "./api";
import { HostsPage } from "./components/HostsPage";
import { emptyHost, HostDetails } from "./components/HostDetails";
import { TerminalView } from "./components/TerminalView";
import { SftpPage } from "./components/SftpPage";
import { SnippetsPage } from "./components/SnippetsPage";
import { ForwardsPage } from "./components/ForwardsPage";
import { KnownHostsPage } from "./components/KnownHostsPage";
import { SettingsPage } from "./components/SettingsPage";
import { LIBRARY_SNIPPETS } from "./snippetLibrary";
import { OsIcon } from "./components/OsIcon";
import {
  CloseIcon,
  FingerprintIcon,
  FolderIcon,
  ForwardIcon,
  HostsIcon,
  PlusIcon,
  SettingsIcon,
  SnippetIcon,
  TerminalIcon,
  VaultIcon,
} from "./components/icons";
import { forgetSessionAuth, useConnector } from "./useConnector";
import "./App.css";

interface TerminalTab {
  key: string;
  title: string;
  os: string | null;
  session: SshSession;
  closed: boolean;
}

const SECTIONS = [
  { key: "hosts", label: "Hosts", icon: HostsIcon },
  { key: "forwards", label: "Port Forwarding", icon: ForwardIcon },
  { key: "snippets", label: "Snippets", icon: SnippetIcon },
  { key: "known", label: "Known Hosts", icon: FingerprintIcon },
  { key: "settings", label: "Settings", icon: SettingsIcon },
] as const;
type Section = (typeof SECTIONS)[number]["key"];

const HOME = "home";
const SFTP = "sftp";

export default function App() {
  const [hosts, setHosts] = useState<Host[]>([]);
  const [snippets, setSnippets] = useState<Snippet[]>([]);
  const [rules, setRules] = useState<ForwardRule[]>([]);
  const [activeForwards, setActiveForwards] = useState<Record<string, string>>({});
  const [tabs, setTabs] = useState<TerminalTab[]>([]);
  const [active, setActive] = useState<string>(HOME);
  const [section, setSection] = useState<Section>("hosts");
  const [details, setDetails] = useState<Host | null>(null);
  const [sftpRequest, setSftpRequest] = useState<{ host: Host; nonce: number } | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [settings, setSettings] = useState<Settings>({
    aiProvider: "ollama",
    ollamaUrl: "http://127.0.0.1:11434",
    ollamaModel: "qwen2.5-coder:3b",
    aiModel: "claude-opus-5-5",
    aiIncludeOutput: false,
    librarySeeded: true,
  });
  const { connectWith, dialogs } = useConnector(hosts);

  const fail = (e: unknown) => setLoadError(String(e));
  const reloadHosts = useCallback(() => hostsApi.list().then(setHosts, fail), []);
  const reloadSnippets = useCallback(() => void snippetsApi.list().then(setSnippets, fail), []);
  const reloadRules = useCallback(() => {
    forwardsApi.list().then(setRules, fail);
    forwardApi.active().then(setActiveForwards, fail);
  }, []);
  useEffect(() => {
    reloadHosts();
    reloadRules();
    // On first start, fill Snippets with the built-in command library.
    settingsApi
      .get()
      .then(async (s) => {
        setSettings(s);
        if (!s.librarySeeded) {
          await snippetsApi.seed(LIBRARY_SNIPPETS);
          setSettings({ ...s, librarySeeded: true });
        }
      })
      .catch(fail)
      .finally(reloadSnippets);
  }, [reloadHosts, reloadSnippets, reloadRules]);

  // ---- Hosts ----------------------------------------------------------------

  const saveHost = async (host: Host, secret: string | null) => {
    const saved = await hostsApi.save(host);
    // Any change to how we log in invalidates what this session remembered.
    forgetSessionAuth(saved.id);
    if (secret !== null) await secretsApi.set(saved.id, secret);
    await reloadHosts();
    setDetails(saved);
    return saved;
  };

  const duplicateHost = async (host: Host) => {
    const copy = await hostsApi.save({ ...host, id: "", label: `${host.label} copy` });
    await reloadHosts();
    setDetails(copy);
  };

  const deleteHost = async (host: Host) => {
    const dependants = hosts.filter((h) => h.jumpHostId === host.id).map((h) => h.label);
    const note = dependants.length ? `\n\nIt is the jump host for: ${dependants.join(", ")}.` : "";
    if (!(await confirm(`Delete host "${host.label}"?${note}`, { kind: "warning" }))) return;
    await hostsApi.remove(host.id);
    if (details?.id === host.id) setDetails(null);
    reloadHosts();
  };

  const openTerminal = async (host: Host) => {
    const session = await connectWith(host, (req) => SshSession.open(req));
    if (!session) return;
    const os = session.os ?? host.os ?? null;
    setTabs((t) => [...t, { key: session.id, title: host.label, os, session, closed: false }]);
    setActive(session.id);
    if (host.id && session.os && session.os !== host.os) {
      await hostsApi.save({ ...host, os: session.os });
      reloadHosts();
    }
  };

  const openLocalTerminal = async () => {
    try {
      const session = await SshSession.openLocal();
      setTabs((t) => [...t, { key: session.id, title: "Local", os: "local", session, closed: false }]);
      setActive(session.id);
    } catch (e) {
      await message(String(e), { title: "Local terminal", kind: "error" });
    }
  };

  const openSftp = (host: Host) => {
    setSftpRequest({ host, nonce: Date.now() });
    setActive(SFTP);
  };

  // ---- Port forwarding ------------------------------------------------------

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

  // ---- Tabs -----------------------------------------------------------------

  const markClosed = useCallback((key: string) => {
    setTabs((t) => t.map((tab) => (tab.key === key ? { ...tab, closed: true } : tab)));
  }, []);

  const closeTab = (key: string) => {
    tabs.find((t) => t.key === key)?.session.close();
    const rest = tabs.filter((t) => t.key !== key);
    setTabs(rest);
    if (active === key) setActive(rest[rest.length - 1]?.key ?? HOME);
  };

  return (
    <div className="app">
      <nav className="topbar">
        <button className={`tab fixed ${active === HOME ? "active" : ""}`} onClick={() => setActive(HOME)}>
          <VaultIcon size={16} /> Home
        </button>
        <button className={`tab fixed ${active === SFTP ? "active" : ""}`} onClick={() => setActive(SFTP)}>
          <FolderIcon size={16} /> SFTP
        </button>
        <div className="tab-strip">
          {tabs.map((tab) => (
            <div
              key={tab.key}
              className={`tab ${active === tab.key ? "active" : ""} ${tab.closed ? "closed" : ""}`}
              onClick={() => setActive(tab.key)}
              onMouseDown={(e) => e.button === 1 && closeTab(tab.key)}
            >
              <OsIcon os={tab.os} size={18} />
              <span className="tab-title">{tab.title}</span>
              <button
                className="tab-close"
                onClick={(e) => {
                  e.stopPropagation();
                  closeTab(tab.key);
                }}
              >
                <CloseIcon size={13} />
              </button>
            </div>
          ))}
          <button className="icon-btn new-tab" title="Local terminal" onClick={openLocalTerminal}>
            <TerminalIcon size={16} />
          </button>
          <button
            className="icon-btn new-tab"
            title="New connection"
            onClick={() => {
              setSection("hosts");
              setActive(HOME);
            }}
          >
            <PlusIcon size={16} />
          </button>
        </div>
      </nav>

      <div className="body">
        <div className="home" hidden={active !== HOME}>
          <aside className="sidebar">
            {SECTIONS.map(({ key, label, icon: Icon }) => (
              <button key={key} className={`nav-item ${section === key ? "active" : ""}`} onClick={() => setSection(key)}>
                <Icon size={18} />
                {label}
              </button>
            ))}
          </aside>

          <main className="content">
            {loadError && <p className="error banner">{loadError}</p>}
            {section === "hosts" && (
              <div className="with-details">
                <HostsPage
                  hosts={hosts}
                  selectedId={details?.id || null}
                  onSelect={setDetails}
                  onConnect={openTerminal}
                  onSftp={openSftp}
                  onNew={(group) => setDetails({ ...emptyHost, group })}
                  onDuplicate={duplicateHost}
                  onDelete={deleteHost}
                  onQuickConnect={openTerminal}
                  onLocalTerminal={openLocalTerminal}
                />
                {details && (
                  <HostDetails
                    host={details}
                    hosts={hosts}
                    onSave={saveHost}
                    onConnect={openTerminal}
                    onDuplicate={duplicateHost}
                    onDelete={deleteHost}
                    onClose={() => setDetails(null)}
                  />
                )}
              </div>
            )}
            {section === "forwards" && (
              <ForwardsPage
                rules={rules}
                hosts={hosts}
                active={activeForwards}
                onStart={startForward}
                onStop={stopForward}
                onChanged={reloadRules}
              />
            )}
            {section === "snippets" && <SnippetsPage snippets={snippets} onChanged={reloadSnippets} />}
            {section === "known" && <KnownHostsPage active={active === HOME && section === "known"} />}
            {section === "settings" && (
              <SettingsPage settings={settings} onSettingsChange={setSettings} onSnippetsChanged={reloadSnippets} />
            )}
          </main>
        </div>

        <div className="sftp-host" hidden={active !== SFTP}>
          <SftpPage hosts={hosts} connectWith={connectWith} request={sftpRequest} />
        </div>

        {tabs.map((tab) => (
          <TerminalView
            key={tab.key}
            session={tab.session}
            active={active === tab.key}
            snippets={snippets}
            includeOutput={settings.aiIncludeOutput}
            aiLabel={settings.aiProvider === "ollama" ? `local · ${settings.ollamaModel}` : settings.aiModel}
            onClosed={() => markClosed(tab.key)}
            onSnippetSaved={reloadSnippets}
          />
        ))}
      </div>
      {dialogs}
    </div>
  );
}
