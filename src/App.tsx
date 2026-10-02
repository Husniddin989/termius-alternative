import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
import { applyTheme, AUTO, storedThemeId, type Theme, terminalTheme } from "./themes";
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
import { IS_MOBILE } from "./platform";
import { useSync } from "./useSync";
import "./App.css";

interface TerminalTab {
  key: string;
  title: string;
  os: string | null;
  /** The saved host this tab connects to; null for the local terminal. */
  host: Host | null;
  session: SshSession;
  closed: boolean;
  /** Dropped by the network rather than ended by the user (exit, logout). */
  lost: boolean;
}

declare global {
  interface Window {
    /** Present in the Android app: keeps the process alive while sessions are open. */
    AndroidSessions?: { setCount(count: number): void };
  }
}

const SECTIONS = [
  { key: "hosts", label: "Hosts", icon: HostsIcon },
  { key: "forwards", label: "Port Forwarding", icon: ForwardIcon },
  { key: "snippets", label: "Snippets", icon: SnippetIcon },
  { key: "known", label: "Known Hosts", icon: FingerprintIcon },
  { key: "settings", label: "Settings", icon: SettingsIcon },
] as const;
type Section = (typeof SECTIONS)[number]["key"];

/** The phone app covers hosts and terminals; the rest stays desktop-only. */
const MOBILE_SECTIONS: string[] = ["hosts", "known", "settings"];

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
    theme: storedThemeId(),
  });
  const [theme, setTheme] = useState<Theme>(() => applyTheme(storedThemeId()));
  const termTheme = useMemo(() => terminalTheme(theme), [theme]);

  // Apply the chosen theme; "auto" also follows OS light/dark changes live.
  useEffect(() => {
    setTheme(applyTheme(settings.theme));
    if (settings.theme !== AUTO) return;
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = () => setTheme(applyTheme(AUTO));
    media.addEventListener("change", onChange);
    return () => media.removeEventListener("change", onChange);
  }, [settings.theme]);
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

  const sync = useSync(() => {
    reloadHosts();
    reloadSnippets();
    reloadRules();
  });

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
    setTabs((t) => [...t, { key: session.id, title: host.label, os, host, session, closed: false, lost: false }]);
    setActive(session.id);
    if (host.id && session.os && session.os !== host.os) {
      await hostsApi.save({ ...host, os: session.os });
      reloadHosts();
    }
  };

  const openLocalTerminal = async () => {
    try {
      const session = await SshSession.openLocal();
      setTabs((t) => [
        ...t,
        { key: session.id, title: "Local", os: "local", host: null, session, closed: false, lost: false },
      ]);
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

  const tabsRef = useRef(tabs);
  tabsRef.current = tabs;
  const hostsRef = useRef(hosts);
  hostsRef.current = hosts;
  const reconnectRef = useRef<(key: string, silent?: boolean) => Promise<void>>(async () => {});

  const markClosed = useCallback((key: string, reason: string | null) => {
    const lost = reason === "connection lost";
    setTabs((t) => t.map((tab) => (tab.key === key ? { ...tab, closed: true, lost } : tab)));
    // Phones switch networks all the time: try once on our own while the app is on screen.
    if (lost && IS_MOBILE && document.visibilityState === "visible")
      setTimeout(() => void reconnectRef.current(key, true), 1500);
  }, []);

  const reconnecting = useRef(new Set<string>());
  const reconnect = useCallback(
    async (key: string, silent = false) => {
      const tab = tabsRef.current.find((t) => t.key === key);
      if (!tab || !tab.closed || reconnecting.current.has(key)) return;
      reconnecting.current.add(key);
      try {
        const host = tab.host && (hostsRef.current.find((h) => h.id === tab.host!.id) ?? tab.host);
        const session = host
          ? await connectWith(host, (req) => SshSession.open(req), { silent })
          : await SshSession.openLocal();
        if (!session) return;
        setTabs((t) => t.map((x) => (x.key === key ? { ...x, session, closed: false, lost: false } : x)));
      } catch (e) {
        if (!silent) await message(String(e), { title: "Reconnect", kind: "error" });
      } finally {
        reconnecting.current.delete(key);
      }
    },
    [connectWith],
  );
  reconnectRef.current = reconnect;

  // Android: a foreground service keeps the app alive while sessions are open.
  const openCount = tabs.filter((t) => !t.closed).length;
  useEffect(() => {
    window.AndroidSessions?.setCount(openCount);
  }, [openCount]);

  // Back in the app after the network dropped a session: reconnect quietly.
  useEffect(() => {
    if (!IS_MOBILE) return;
    const onVisible = () => {
      if (document.visibilityState !== "visible") return;
      for (const t of tabsRef.current) if (t.closed && t.lost) void reconnect(t.key, true);
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [reconnect]);

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
        {!IS_MOBILE && (
          <button className={`tab fixed ${active === SFTP ? "active" : ""}`} onClick={() => setActive(SFTP)}>
            <FolderIcon size={16} /> SFTP
          </button>
        )}
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
          {!IS_MOBILE && (
            <button className="icon-btn new-tab" title="Local terminal" onClick={openLocalTerminal}>
              <TerminalIcon size={16} />
            </button>
          )}
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
            {SECTIONS.filter((s) => !IS_MOBILE || MOBILE_SECTIONS.includes(s.key)).map(({ key, label, icon: Icon }) => (
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
                  onLocalTerminal={IS_MOBILE ? undefined : openLocalTerminal}
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
              <SettingsPage
                settings={settings}
                onSettingsChange={setSettings}
                onSnippetsChanged={reloadSnippets}
                sync={sync}
              />
            )}
          </main>
        </div>

        {!IS_MOBILE && (
          <div className="sftp-host" hidden={active !== SFTP}>
            <SftpPage hosts={hosts} connectWith={connectWith} request={sftpRequest} />
          </div>
        )}

        {tabs.map((tab) => (
          <TerminalView
            key={tab.key}
            session={tab.session}
            active={active === tab.key}
            snippets={snippets}
            includeOutput={settings.aiIncludeOutput}
            termTheme={termTheme}
            aiLabel={settings.aiProvider === "ollama" ? `local · ${settings.ollamaModel}` : settings.aiModel}
            onClosed={(reason) => markClosed(tab.key, reason)}
            onReconnect={() => reconnect(tab.key)}
            onSnippetSaved={reloadSnippets}
          />
        ))}
      </div>
      {dialogs}
    </div>
  );
}
