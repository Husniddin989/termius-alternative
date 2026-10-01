import { Channel, invoke } from "@tauri-apps/api/core";

export type AuthMethod = "password" | "key";

export interface Host {
  id: string;
  label: string;
  host: string;
  port: number;
  username: string;
  authMethod: AuthMethod;
  keyPath?: string | null;
  group?: string | null;
}

export type Auth =
  | { kind: "password"; password: string }
  | { kind: "key"; keyPath: string; passphrase?: string | null };

type SshEvent =
  | { event: "data"; data: number[] }
  | { event: "closed"; data: { reason: string | null } };

export const hostsApi = {
  list: () => invoke<Host[]>("hosts_list"),
  save: (host: Host) => invoke<Host>("hosts_save", { host }),
  remove: (id: string) => invoke<void>("hosts_delete", { id }),
};

export interface SessionListener {
  onData(bytes: Uint8Array): void;
  onClosed(reason: string | null): void;
}

/**
 * A live SSH shell. Output that arrives before a terminal is attached is
 * buffered, so the session can be opened before its tab is rendered.
 */
export class SshSession {
  private listener: SessionListener | null = null;
  private pending: Uint8Array[] = [];
  private closedReason: string | null | undefined = undefined;

  private constructor(public readonly id: string) {}

  static async open(host: Host, auth: Auth, cols = 120, rows = 32): Promise<SshSession> {
    let session: SshSession | null = null;
    const early: SshEvent[] = [];
    const channel = new Channel<SshEvent>();
    channel.onmessage = (msg) => (session ? session.handle(msg) : early.push(msg));

    const id = await invoke<string>("ssh_connect", {
      request: { host: host.host, port: host.port, username: host.username, auth, cols, rows },
      onEvent: channel,
    });
    session = new SshSession(id);
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
    return invoke("ssh_write", { id: this.id, data });
  }

  resize(cols: number, rows: number) {
    return invoke("ssh_resize", { id: this.id, cols, rows });
  }

  close() {
    return invoke("ssh_close", { id: this.id });
  }
}
