import { useEffect, useMemo, useState } from "react";
import { type AuthMethod, type Host, secretsApi } from "../api";
import { DetailsPanel, Field, Section } from "./DetailsPanel";
import { OsIcon } from "./OsIcon";
import { ChevronDown, EyeIcon, EyeOffIcon, GroupIcon, KeyIcon, LockIcon, UserIcon } from "./icons";

export const emptyHost: Host = {
  id: "",
  label: "",
  host: "",
  port: 22,
  username: "root",
  authMethod: "password",
  keyPath: "~/.ssh/id_ed25519",
  group: null,
  jumpHostId: null,
  os: null,
};

interface Props {
  host: Host;
  hosts: Host[];
  /** Saves the host (and the secret, if one was typed) and returns the stored host. */
  onSave: (host: Host, secret: string | null) => Promise<Host>;
  onConnect: (host: Host) => void;
  onDuplicate: (host: Host) => void;
  onDelete: (host: Host) => void;
  onClose: () => void;
}

const AUTH_LABELS: Record<AuthMethod, string> = {
  password: "Password",
  key: "Key",
  agent: "Agent",
};

export function HostDetails({ host: initial, hosts, onSave, onConnect, onDuplicate, onDelete, onClose }: Props) {
  const [host, setHost] = useState<Host>(initial);
  const [secret, setSecret] = useState("");
  const [showSecret, setShowSecret] = useState(false);
  const [hasSecret, setHasSecret] = useState(false);
  const [more, setMore] = useState(!!initial.jumpHostId);
  const [error, setError] = useState<string | null>(null);
  const isNew = !initial.id;

  useEffect(() => {
    setHost(initial);
    setSecret("");
    setError(null);
    setMore(!!initial.jumpHostId);
    if (initial.id) secretsApi.get(initial.id).then((s) => setHasSecret(s !== null), () => setHasSecret(false));
    else setHasSecret(false);
  }, [initial]);

  const set = <K extends keyof Host>(key: K, value: Host[K]) => setHost((h) => ({ ...h, [key]: value }));

  const groups = useMemo(
    () => [...new Set(hosts.map((h) => h.group).filter((g): g is string => !!g))].sort(),
    [hosts],
  );
  const jumpCandidates = hosts.filter((h) => h.id !== host.id && h.jumpHostId !== host.id);
  const dirty = isNew || secret !== "" || JSON.stringify(host) !== JSON.stringify(initial);

  const normalized = (): Host => ({
    ...host,
    host: host.host.trim(),
    label: host.label.trim() || host.host.trim(),
    group: host.group?.trim() || null,
    keyPath: host.authMethod === "key" ? host.keyPath : null,
    jumpHostId: host.jumpHostId || null,
  });

  const save = async (): Promise<Host | null> => {
    if (!host.host.trim()) {
      setError("Enter an IP address or hostname.");
      return null;
    }
    try {
      const saved = await onSave(normalized(), host.authMethod === "agent" ? null : secret || null);
      setSecret("");
      setError(null);
      return saved;
    } catch (e) {
      setError(String(e));
      return null;
    }
  };

  const connect = async () => {
    const saved = dirty ? await save() : initial;
    if (saved) onConnect(saved);
  };

  const forgetSecret = async () => {
    await secretsApi.remove(host.id);
    setHasSecret(false);
  };

  return (
    <DetailsPanel
      title={isNew ? "New host" : "Edit host"}
      subtitle={isNew ? undefined : host.label}
      onClose={onClose}
      menu={
        isNew
          ? []
          : [
              { label: "Duplicate", onClick: () => onDuplicate(initial) },
              { label: "Delete", onClick: () => onDelete(initial), danger: true },
            ]
      }
      footer={
        <>
          {error && <p className="error small">{error}</p>}
          <div className="foot-buttons">
            {dirty && (
              <button className="secondary" onClick={save}>
                Save
              </button>
            )}
            <button className="primary wide" onClick={connect}>
              Connect
            </button>
          </div>
        </>
      }
    >
      <Section title="Connection">
        <div className="address-row">
          <OsIcon os={host.os} size={40} />
          <Field
            autoFocus={isNew}
            placeholder="IP address or hostname"
            value={host.host}
            onChange={(e) => set("host", e.target.value)}
          />
          <input
            className="port-input"
            type="number"
            min={1}
            max={65535}
            title="SSH port"
            value={host.port}
            onChange={(e) => set("port", Number(e.target.value))}
          />
        </div>
      </Section>

      <Section title="Details">
        <Field placeholder="Name (optional)" value={host.label} onChange={(e) => set("label", e.target.value)} />
        <Field
          icon={<GroupIcon size={15} />}
          placeholder="Group (optional)"
          list="group-options"
          value={host.group ?? ""}
          onChange={(e) => set("group", e.target.value)}
        />
        <datalist id="group-options">
          {groups.map((g) => (
            <option key={g} value={g} />
          ))}
        </datalist>
      </Section>

      <Section title="Authentication">
        <Field icon={<UserIcon size={15} />} placeholder="Username" value={host.username} onChange={(e) => set("username", e.target.value)} />

        <div className="segmented">
          {(Object.keys(AUTH_LABELS) as AuthMethod[]).map((m) => (
            <button key={m} className={host.authMethod === m ? "on" : ""} onClick={() => set("authMethod", m)}>
              {AUTH_LABELS[m]}
            </button>
          ))}
        </div>

        {host.authMethod === "key" && (
          <Field
            icon={<KeyIcon size={15} />}
            placeholder="Private key path, e.g. ~/.ssh/id_ed25519"
            value={host.keyPath ?? ""}
            onChange={(e) => set("keyPath", e.target.value)}
          />
        )}
        {host.authMethod !== "agent" ? (
          <Field
            icon={<LockIcon size={15} />}
            type={showSecret ? "text" : "password"}
            placeholder={
              hasSecret
                ? "•••••• saved in keychain"
                : host.authMethod === "key"
                  ? "Passphrase (optional)"
                  : "Password"
            }
            value={secret}
            onChange={(e) => setSecret(e.target.value)}
            trailing={
              <button type="button" className="icon-btn" onClick={() => setShowSecret((s) => !s)} title="Show">
                {showSecret ? <EyeOffIcon size={15} /> : <EyeIcon size={15} />}
              </button>
            }
          />
        ) : (
          <p className="muted small">Uses the keys loaded in your SSH agent (ssh-add).</p>
        )}
        {hasSecret && host.authMethod !== "agent" && (
          <button className="link small" onClick={forgetSecret}>
            Forget saved {host.authMethod === "key" ? "passphrase" : "password"}
          </button>
        )}
      </Section>

      <Section
        title={
          <button className="link section-toggle" onClick={() => setMore((m) => !m)}>
            Advanced <ChevronDown size={14} className={more ? "flip" : ""} />
          </button>
        }
      >
        {more && (
          <label className="field select">
            <span className="field-label">Jump host</span>
            <select value={host.jumpHostId ?? ""} onChange={(e) => set("jumpHostId", e.target.value || null)}>
              <option value="">None — connect directly</option>
              {jumpCandidates.map((h) => (
                <option key={h.id} value={h.id}>
                  {h.label} ({h.username}@{h.host})
                </option>
              ))}
            </select>
          </label>
        )}
      </Section>
    </DetailsPanel>
  );
}
