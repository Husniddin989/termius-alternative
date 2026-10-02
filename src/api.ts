import { Channel, invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

export type AuthMethod = "password" | "key" | "agent";

export interface Host {
  id: string;
  label: string;
  host: string;
  port: number;
  username: string;
  authMethod: AuthMethod;
  keyPath?: string | null;
  group?: string | null;
  jumpHostId?: string | null;
  /** Distribution id detected on connect, e.g. "ubuntu". */
  os?: string | null;
}

export interface Snippet {
  id: string;
  name: string;
  command: string;
  category?: string | null;
}

export type AiProvider = "ollama" | "anthropic";

export interface Settings {
  aiProvider: AiProvider;
  ollamaUrl: string;
  ollamaModel: string;
  aiModel: string;
  aiIncludeOutput: boolean;
  librarySeeded: boolean;
  theme: string;
}

export interface AiSuggestion {
  command: string;
  explanation: string;
  dangerous: boolean;
}

export type ForwardKind = "local" | "dynamic";

export interface ForwardRule {
  id: string;
  label: string;
  hostId: string;
  kind: ForwardKind;
  bindHost: string;
  bindPort: number;
  destHost?: string | null;
  destPort?: number | null;
}

export type Auth =
  | { kind: "password"; password: string }
  | { kind: "key"; keyPath: string; passphrase?: string | null }
  | { kind: "agent" };

export interface Target {
  host: string;
  port: number;
  username: string;
  auth: Auth;
}

export interface ConnectRequest {
  target: Target;
  jump?: Target | null;
}

export interface HostKeyPrompt {
  id: string;
  host: string;
  port: number;
  algorithm: string;
  fingerprint: string;
}

export interface SftpEntry {
  name: string;
  path: string;
  isDir: boolean;
  isSymlink: boolean;
  size: number;
  modified: number | null;
  permissions: number | null;
}

export interface KnownHost {
  line: number;
  host: string;
  algorithm: string;
  fingerprint: string;
}

export interface Progress {
  done: number;
  total: number;
}

/** Fired after anything that syncs was changed on this device. */
export const LOCAL_CHANGE_EVENT = "app:local-change";

function changed<T>(result: Promise<T>): Promise<T> {
  return result.then((value) => {
    window.dispatchEvent(new Event(LOCAL_CHANGE_EVENT));
    return value;
  });
}

function crud<T>(noun: string, key: string) {
  return {
    list: () => invoke<T[]>(`${noun}_list`),
    save: (item: T) => changed(invoke<T>(`${noun}_save`, { [key]: item })),
    remove: (id: string) => changed(invoke<void>(`${noun}_delete`, { id })),
  };
}

export const hostsApi = crud<Host>("hosts", "host");
export const snippetsApi = {
  ...crud<Snippet>("snippets", "snippet"),
  /** Adds the snippets whose command isn't saved yet; returns how many were added. */
  seed: (snippets: Snippet[]) => changed(invoke<number>("snippets_seed", { snippets })),
};

export const settingsApi = {
  get: () => invoke<Settings>("settings_get"),
  set: (settings: Settings) => invoke<void>("settings_set", { settings }),
};

export interface LocalModel {
  name: string;
  size: number;
}

export interface PullProgress {
  status: string;
  completed: number;
  total: number;
}

export const ollamaApi = {
  models: (url: string) => invoke<LocalModel[]>("ollama_models", { url }),
  pull: (url: string, model: string, onProgress: (p: PullProgress) => void) => {
    const channel = new Channel<PullProgress>();
    channel.onmessage = onProgress;
    return invoke<void>("ollama_pull", { url, model, onProgress: channel });
  },
};

export const aiApi = {
  hasKey: () => invoke<boolean>("ai_key_status"),
  /** An empty key removes the stored one. */
  setKey: (key: string) => invoke<void>("ai_key_set", { key }),
  suggest: (request: { prompt: string; os: string | null; currentLine: string | null; recentOutput: string | null }) =>
    invoke<AiSuggestion>("ai_suggest", { request }),
};
export const forwardsApi = crud<ForwardRule>("forwards", "rule");

export const secretsApi = {
  get: (hostId: string) => invoke<string | null>("secret_get", { hostId }),
  set: (hostId: string, secret: string) => changed(invoke<void>("secret_set", { hostId, secret })),
  remove: (hostId: string) => changed(invoke<void>("secret_delete", { hostId })),
};

export interface SyncStatus {
  enabled: boolean;
  /** GitHub account holding the vault. */
  login: string | null;
  lastSync: number | null;
  lastError: string | null;
}

export interface SyncReport {
  /** Something on this device was updated from the vault. */
  changed: boolean;
  pushed: boolean;
  hosts: number;
  at: number;
}

export const syncApi = {
  status: () => invoke<SyncStatus>("sync_status"),
  setup: (token: string, passphrase: string) => invoke<SyncReport>("sync_setup", { token, passphrase }),
  /** Returns null when sync is off on this device. */
  now: () => invoke<SyncReport | null>("sync_now"),
  disable: () => invoke<void>("sync_disable"),
};

export const hostKeyApi = {
  onPrompt: (cb: (p: HostKeyPrompt) => void): Promise<UnlistenFn> =>
    listen<HostKeyPrompt>("host-key-prompt", (e) => cb(e.payload)),
  respond: (id: string, accept: boolean) => invoke<void>("host_key_respond", { id, accept }),
};

export const knownHostsApi = {
  list: () => invoke<KnownHost[]>("known_hosts_list"),
  remove: (line: number) => invoke<void>("known_hosts_remove", { line }),
};

export const localApi = {
  home: () => invoke<string>("local_home"),
  list: (path: string) => invoke<SftpEntry[]>("local_list", { path }),
};

export const forwardApi = {
  start: (ruleId: string, request: ConnectRequest) =>
    invoke<string>("forward_start", { ruleId, request }),
  stop: (ruleId: string) => invoke<void>("forward_stop", { ruleId }),
  active: () => invoke<Record<string, string>>("forward_active"),
};

function progressChannel(onProgress?: (p: Progress) => void) {
  const channel = new Channel<Progress>();
  channel.onmessage = (p) => onProgress?.(p);
  return channel;
}

export const sftpApi = {
  open: (request: ConnectRequest) => invoke<{ id: string; home: string }>("sftp_open", { request }),
  list: (id: string, path: string) => invoke<SftpEntry[]>("sftp_list", { id, path }),
  download: (id: string, remote: string, local: string, onProgress?: (p: Progress) => void) =>
    invoke<void>("sftp_download", { id, remote, local, onProgress: progressChannel(onProgress) }),
  upload: (id: string, local: string, remote: string, onProgress?: (p: Progress) => void) =>
    invoke<void>("sftp_upload", { id, local, remote, onProgress: progressChannel(onProgress) }),
  mkdir: (id: string, path: string) => invoke<void>("sftp_mkdir", { id, path }),
  rename: (id: string, from: string, to: string) => invoke<void>("sftp_rename", { id, from, to }),
  remove: (id: string, path: string, isDir: boolean) =>
    invoke<void>("sftp_remove", { id, path, isDir }),
  close: (id: string) => invoke<void>("sftp_close", { id }),
};

type SshEvent =
  | { event: "data"; data: number[] }
  | { event: "closed"; data: { reason: string | null } };

export interface SessionListener {
  onData(bytes: Uint8Array): void;
  onClosed(reason: string | null): void;
}

/** Command prefix of the backend that owns a shell: remote SSH or local PTY. */
type ShellBackend = "ssh" | "pty";

/**
 * A live shell — remote over SSH or local in a PTY. Output that arrives
 * before a terminal is attached is buffered, so the session can be opened
 * before its tab is rendered.
 */
export class SshSession {
  private listener: SessionListener | null = null;
  private pending: Uint8Array[] = [];
  private closedReason: string | null | undefined = undefined;

  private constructor(
    public readonly id: string,
    /** Remote OS detected while connecting, "local" for a local shell, or null. */
    public readonly os: string | null,
    private readonly backend: ShellBackend = "ssh",
  ) {}

  /** Opens the user's own shell on this computer. */
  static async openLocal(cols = 120, rows = 32): Promise<SshSession> {
    let session: SshSession | null = null;
    const early: SshEvent[] = [];
    const channel = new Channel<SshEvent>();
    channel.onmessage = (msg) => (session ? session.handle(msg) : early.push(msg));
    const id = await invoke<string>("pty_open", { cols, rows, onEvent: channel });
    session = new SshSession(id, "local", "pty");
    early.forEach((msg) => session!.handle(msg));
    return session;
  }

  static async open(request: ConnectRequest, cols = 120, rows = 32): Promise<SshSession> {
    let session: SshSession | null = null;
    const early: SshEvent[] = [];
    const channel = new Channel<SshEvent>();
    channel.onmessage = (msg) => (session ? session.handle(msg) : early.push(msg));

    const opened = await invoke<{ id: string; os: string | null }>("ssh_connect", {
      request,
      cols,
      rows,
      onEvent: channel,
    });
    session = new SshSession(opened.id, opened.os);
    early.forEach((msg) => session!.handle(msg));
    return session;
  }

  private handle(msg: SshEvent) {
    if (msg.event === "data") {
      const bytes = new Uint8Array(msg.data);
      if (this.listener) this.listener.onData(bytes);
      else this.pending.push(bytes);
    } else {
      this.closedReason = msg.data.reason;
      this.listener?.onClosed(msg.data.reason);
    }
  }

  attach(listener: SessionListener) {
    this.listener = listener;
    this.pending.forEach((b) => listener.onData(b));
    this.pending = [];
    if (this.closedReason !== undefined) listener.onClosed(this.closedReason);
  }

  detach() {
    this.listener = null;
  }

  write(text: string) {
    const data = Array.from(new TextEncoder().encode(text));
    return invoke(`${this.backend}_write`, { id: this.id, data });
  }

  resize(cols: number, rows: number) {
    return invoke(`${this.backend}_resize`, { id: this.id, cols, rows });
  }

  close() {
    return invoke(`${this.backend}_close`, { id: this.id });
  }

  /** Entries of a directory on the session's machine ("~" allowed); dirs end with "/". */
  async listDir(dir: string): Promise<string[]> {
    if (this.backend === "ssh") return invoke<string[]>("ssh_list_dir", { id: this.id, dir });
    const home = await localApi.home();
    const path = dir === "~" ? home : dir.startsWith("~/") ? `${home}/${dir.slice(2)}` : dir;
    const entries = await localApi.list(path);
    return entries.map((e) => (e.isDir ? `${e.name}/` : e.name));
  }

  /** The user's shell history on that machine, oldest first. */
  history(): Promise<string[]> {
    return this.backend === "ssh" ? invoke<string[]>("ssh_history", { id: this.id }) : invoke<string[]>("local_history");
  }
}
