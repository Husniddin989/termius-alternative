import { useCallback, useEffect, useRef, useState } from "react";
import { message } from "@tauri-apps/plugin-dialog";
import {
  type Auth,
  type ConnectRequest,
  type Host,
  type HostKeyPrompt,
  hostKeyApi,
  secretsApi,
} from "./api";
import { ConnectDialog, type Credentials } from "./components/ConnectDialog";
import { HostKeyDialog } from "./components/HostKeyDialog";

interface AuthPrompt {
  host: Host;
  error: string | null;
  resolve: (c: Credentials | null) => void;
}

/** Credentials that worked during this app session, so we don't ask twice. */
const sessionAuth = new Map<string, Auth>();

/** Drops credentials cached for this session (after editing or forgetting them). */
export function forgetSessionAuth(hostId: string) {
  sessionAuth.delete(hostId);
}

/** Saved credentials for a host, plus why the keychain couldn't be read, if it failed. */
async function storedAuth(host: Host): Promise<{ auth: Auth | null; error: string | null }> {
  if (host.authMethod === "agent") return { auth: { kind: "agent" }, error: null };
  const cached = host.id ? sessionAuth.get(host.id) : undefined;
  if (cached) return { auth: cached, error: null };
  if (!host.id) return { auth: null, error: null };
  let secret: string | null;
  try {
    secret = await secretsApi.get(host.id);
  } catch (e) {
    return { auth: null, error: `Could not read the saved password from the keychain: ${e}` };
  }
  if (secret === null) return { auth: null, error: null };
  return { auth: authFromSecret(host, secret), error: null };
}

function authFromSecret(host: Host, secret: string): Auth {
  return host.authMethod === "password"
    ? { kind: "password", password: secret }
    : { kind: "key", keyPath: host.keyPath ?? "", passphrase: secret || null };
}

async function remember(host: Host, auth: Auth, save: string | null): Promise<string | null> {
  if (!host.id) return null;
  sessionAuth.set(host.id, auth);
  if (save === null) return null;
  try {
    await secretsApi.set(host.id, save);
    return null;
  } catch (e) {
    return `Connected, but the password for ${host.label} could not be saved to the keychain: ${e}`;
  }
}

const toTarget = (h: Host, auth: Auth) => ({ host: h.host, port: h.port, username: h.username, auth });

/**
 * Resolves credentials for a host (and its jump host) from the keychain or by
 * asking the user, runs `op`, and re-asks with the error shown when it fails.
 * Also renders the host-key confirmation dialog the backend may request.
 */
export function useConnector(hosts: Host[]) {
  const hostsRef = useRef(hosts);
  hostsRef.current = hosts;
  const [authPrompt, setAuthPrompt] = useState<AuthPrompt | null>(null);
  const [keyPrompts, setKeyPrompts] = useState<HostKeyPrompt[]>([]);
  const [status, setStatus] = useState<string | null>(null);

  useEffect(() => {
    const unlisten = hostKeyApi.onPrompt((p) => setKeyPrompts((q) => [...q, p]));
    return () => void unlisten.then((f) => f());
  }, []);

  const askAuth = (host: Host, error: string | null) =>
    new Promise<Credentials | null>((resolve) => setAuthPrompt({ host, error, resolve }));

  const connectWith = useCallback(
    async <T,>(host: Host, op: (req: ConnectRequest) => Promise<T>): Promise<T | null> => {
      const jumpHost = host.jumpHostId
        ? hostsRef.current.find((h) => h.id === host.jumpHostId) ?? null
        : null;
      if (host.jumpHostId && !jumpHost) {
        await message("The jump host of this host no longer exists.", { kind: "error" });
        return null;
      }

      const storedTarget = await storedAuth(host);
      const storedJump = jumpHost ? await storedAuth(jumpHost) : { auth: null, error: null };
      let target = storedTarget.auth;
      let jump = storedJump.auth;
      let saveTarget: string | null = null;
      let saveJump: string | null = null;
      let error: string | null = storedJump.error ?? storedTarget.error;

      for (;;) {
        if (jumpHost && !jump) {
          const c = await askAuth(jumpHost, error);
          if (!c) return null;
          [jump, saveJump] = [c.auth, c.save];
        }
        if (!target) {
          const c = await askAuth(host, jumpHost ? null : error);
          if (!c) return null;
          [target, saveTarget] = [c.auth, c.save];
        }

        setStatus(`Connecting to ${host.label}…`);
        try {
          const result = await op({
            target: toTarget(host, target),
            jump: jumpHost && jump ? toTarget(jumpHost, jump) : null,
          });
          const saveErrors = [
            await remember(host, target, saveTarget),
            jumpHost && jump ? await remember(jumpHost, jump, saveJump) : null,
          ].filter(Boolean);
          if (saveErrors.length) void message(saveErrors.join("\n\n"), { title: "Keychain", kind: "warning" });
          return result;
        } catch (e) {
          error = String(e);
          if (/HOST KEY CHANGED|was not accepted|certificates are not supported/.test(error)) {
            await message(error, { title: "Connection refused", kind: "error" });
            return null;
          }
          if (error.startsWith("jump host")) {
            jump = null;
            if (jumpHost) sessionAuth.delete(jumpHost.id);
          } else {
            target = null;
            sessionAuth.delete(host.id);
          }
        } finally {
          setStatus(null);
        }
      }
    },
    [],
  );

  const answerKey = (accept: boolean) => {
    const [current, ...rest] = keyPrompts;
    if (!current) return;
    hostKeyApi.respond(current.id, accept);
    setKeyPrompts(rest);
  };

  const dialogs = (
    <>
      {authPrompt && (
        <ConnectDialog
          host={authPrompt.host}
          error={authPrompt.error}
          onSubmit={(c) => {
            setAuthPrompt(null);
            authPrompt.resolve(c);
          }}
          onCancel={() => {
            setAuthPrompt(null);
            authPrompt.resolve(null);
          }}
        />
      )}
      {keyPrompts[0] && (
        <HostKeyDialog
          prompt={keyPrompts[0]}
          onAccept={() => answerKey(true)}
          onReject={() => answerKey(false)}
        />
      )}
      {status && <div className="toast">{status}</div>}
    </>
  );

  return { connectWith, dialogs };
}
