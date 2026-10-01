import { useCallback, useEffect, useRef, useState } from "react";
import { confirm } from "@tauri-apps/plugin-dialog";
import { type ConnectRequest, type Host, localApi, type SftpEntry, sftpApi } from "../api";
import { type DragFile, FilePane } from "./FilePane";
import { OsIcon } from "./OsIcon";
import { PromptDialog, type PromptRequest } from "./PromptDialog";
import { CloseIcon, DownloadIcon, PlusIcon, SearchIcon, UploadIcon } from "./icons";

type ConnectWith = <T>(host: Host, op: (req: ConnectRequest) => Promise<T>) => Promise<T | null>;

interface Props {
  hosts: Host[];
  connectWith: ConnectWith;
  /** Host to open in the remote pane; `nonce` changes on every request. */
  request: { host: Host; nonce: number } | null;
}

interface Listing {
  path: string;
  entries: SftpEntry[];
  loading: boolean;
  error: string | null;
}

interface Remote {
  host: Host;
  id: string;
}

interface Transfer {
  key: number;
  name: string;
  direction: "up" | "down";
  done: number;
  total: number;
  state: "running" | "done" | "error";
  error?: string;
}

const emptyListing: Listing = { path: "", entries: [], loading: false, error: null };

const remoteJoin = (dir: string, name: string) => (dir.endsWith("/") ? dir + name : `${dir}/${name}`);
const remoteParent = (p: string) => p.replace(/\/[^/]+\/?$/, "") || "/";
const localSep = (p: string) => (p.includes("\\") ? "\\" : "/");
const localJoin = (dir: string, name: string) => {
  const sep = localSep(dir);
  return dir.endsWith(sep) ? dir + name : dir + sep + name;
};
const localParent = (p: string) => {
  const sep = localSep(p);
  const trimmed = p.replace(/[\\/]+$/, "");
  const idx = trimmed.lastIndexOf(sep);
  if (idx <= 0) return sep === "/" ? "/" : trimmed.slice(0, 3);
  const parent = trimmed.slice(0, idx);
  return /^[A-Za-z]:$/.test(parent) ? parent + "\\" : parent;
};

let transferSeq = 0;

export function SftpPage({ hosts, connectWith, request }: Props) {
  const [local, setLocal] = useState<Listing>(emptyListing);
  const [remote, setRemote] = useState<Remote | null>(null);
  const [remoteList, setRemoteList] = useState<Listing>(emptyListing);
  const [transfers, setTransfers] = useState<Transfer[]>([]);
  const [prompt, setPrompt] = useState<PromptRequest | null>(null);
  const [pickerQuery, setPickerQuery] = useState("");
  const remoteRef = useRef<Remote | null>(null);
  remoteRef.current = remote;
  const localPathRef = useRef("");
  localPathRef.current = local.path;
  const remotePathRef = useRef("");
  remotePathRef.current = remoteList.path;

  const loadLocal = useCallback(async (path: string) => {
    setLocal((l) => ({ ...l, loading: true }));
    try {
      const entries = await localApi.list(path);
      setLocal({ path, entries, loading: false, error: null });
    } catch (e) {
      setLocal((l) => ({ ...l, loading: false, error: String(e) }));
    }
  }, []);

  const loadRemote = useCallback(async (path: string, r: Remote | null = remoteRef.current) => {
    if (!r) return;
    setRemoteList((l) => ({ ...l, loading: true }));
    try {
      const entries = await sftpApi.list(r.id, path);
      setRemoteList({ path, entries, loading: false, error: null });
    } catch (e) {
      setRemoteList((l) => ({ ...l, loading: false, error: String(e) }));
    }
  }, []);

  useEffect(() => {
    localApi.home().then(loadLocal);
  }, [loadLocal]);

  const disconnect = useCallback(() => {
    if (remoteRef.current) sftpApi.close(remoteRef.current.id);
    setRemote(null);
    setRemoteList(emptyListing);
  }, []);

  const openHost = useCallback(
    async (host: Host) => {
      const opened = await connectWith(host, (req) => sftpApi.open(req));
      if (!opened) return;
      if (remoteRef.current) sftpApi.close(remoteRef.current.id);
      const r = { host, id: opened.id };
      setRemote(r);
      loadRemote(opened.home, r);
    },
    [connectWith, loadRemote],
  );

  useEffect(() => {
    if (request) openHost(request.host);
  }, [request, openHost]);

  // Close the remote session when the page goes away.
  useEffect(() => () => void (remoteRef.current && sftpApi.close(remoteRef.current.id)), []);

  const ask = (r: Omit<PromptRequest, "resolve">) =>
    new Promise<string | null>((resolve) => setPrompt({ ...r, resolve }));

  const track = async (name: string, direction: Transfer["direction"], op: (p: (x: { done: number; total: number }) => void) => Promise<void>) => {
    const key = ++transferSeq;
    const update = (patch: Partial<Transfer>) =>
      setTransfers((ts) => ts.map((t) => (t.key === key ? { ...t, ...patch } : t)));
    setTransfers((ts) => [...ts, { key, name, direction, done: 0, total: 0, state: "running" }]);
    try {
      await op((p) => update({ done: p.done, total: p.total }));
      update({ state: "done" });
      return true;
    } catch (e) {
      update({ state: "error", error: String(e) });
      return false;
    }
  };

  const upload = async (entry: SftpEntry) => {
    const r = remoteRef.current;
    if (!r || entry.isDir) return;
    const dir = remotePathRef.current;
    if (await track(entry.name, "up", (p) => sftpApi.upload(r.id, entry.path, remoteJoin(dir, entry.name), p))) {
      if (remotePathRef.current === dir) loadRemote(dir);
    }
  };

  const download = async (entry: SftpEntry) => {
    const r = remoteRef.current;
    if (!r || entry.isDir) return;
    const dir = localPathRef.current;
    if (await track(entry.name, "down", (p) => sftpApi.download(r.id, entry.path, localJoin(dir, entry.name), p))) {
      if (localPathRef.current === dir) loadLocal(dir);
    }
  };

  const remoteAction = async (op: () => Promise<unknown>) => {
    try {
      await op();
    } catch (e) {
      setRemoteList((l) => ({ ...l, error: String(e) }));
    }
    loadRemote(remotePathRef.current);
  };

  const newFolder = async () => {
    const r = remoteRef.current;
    const name = await ask({ title: "New folder", label: "Folder name", confirmLabel: "Create" });
    if (r && name) remoteAction(() => sftpApi.mkdir(r.id, remoteJoin(remotePathRef.current, name)));
  };

  const rename = async (entry: SftpEntry) => {
    const r = remoteRef.current;
    const name = await ask({ title: "Rename", label: "New name", initial: entry.name, confirmLabel: "Rename" });
    if (r && name && name !== entry.name)
      remoteAction(() => sftpApi.rename(r.id, entry.path, remoteJoin(remotePathRef.current, name)));
  };

  const remove = async (entry: SftpEntry) => {
    const r = remoteRef.current;
    const what = entry.isDir ? `folder "${entry.name}" and everything in it` : `"${entry.name}"`;
    if (r && (await confirm(`Delete ${what} on ${r.host.label}?`, { title: "Delete", kind: "warning" })))
      remoteAction(() => sftpApi.remove(r.id, entry.path, entry.isDir));
  };

  const pickerHosts = hosts.filter((h) =>
    [h.label, h.host, h.username].some((v) => v.toLowerCase().includes(pickerQuery.toLowerCase())),
  );

  return (
    <div className="sftp-page">
      <div className="panes">
        <FilePane
          side="local"
          title={<span className="pane-label">Local</span>}
          path={local.path}
          entries={local.entries}
          loading={local.loading}
          error={local.error}
          onNavigate={loadLocal}
          onParent={() => loadLocal(localParent(local.path))}
          onRefresh={() => loadLocal(local.path)}
          onOpenFile={upload}
          onDrop={(f: DragFile) => download(f.entry)}
          menuFor={(e) => (e.isDir || !remote ? [] : [{ label: `Upload to ${remote.host.label}`, onClick: () => upload(e) }])}
        />

        {remote ? (
          <FilePane
            side="remote"
            title={
              <span className="pane-label">
                <OsIcon os={remote.host.os} size={20} /> {remote.host.label}
              </span>
            }
            headerActions={
              <>
                <button className="icon-btn" onClick={newFolder} title="New folder">
                  <PlusIcon size={16} />
                </button>
                <button className="icon-btn" onClick={disconnect} title="Disconnect">
                  <CloseIcon size={16} />
                </button>
              </>
            }
            path={remoteList.path}
            entries={remoteList.entries}
            loading={remoteList.loading}
            error={remoteList.error}
            onNavigate={(p) => loadRemote(p)}
            onParent={() => loadRemote(remoteParent(remoteList.path))}
            onRefresh={() => loadRemote(remoteList.path)}
            onOpenFile={download}
            onDrop={(f: DragFile) => upload(f.entry)}
            menuFor={(e) => [
              ...(e.isDir ? [] : [{ label: "Download to local folder", onClick: () => download(e) }]),
              { label: "Rename", onClick: () => rename(e) },
              { label: "Delete", onClick: () => remove(e), danger: true },
            ]}
          />
        ) : (
          <div className="pane picker">
            <div className="pane-head">
              <div className="pane-title">
                <span className="pane-label">Remote</span>
              </div>
            </div>
            <div className="picker-body">
              <h3>Choose a host</h3>
              <label className="field">
                <span className="field-icon">
                  <SearchIcon size={15} />
                </span>
                <input placeholder="Search hosts" value={pickerQuery} onChange={(e) => setPickerQuery(e.target.value)} />
              </label>
              <div className="picker-list">
                {pickerHosts.map((h) => (
                  <button key={h.id} className="picker-item" onClick={() => openHost(h)}>
                    <OsIcon os={h.os} size={30} />
                    <span className="card-text">
                      <strong>{h.label}</strong>
                      <span>
                        {h.username}@{h.host}
                      </span>
                    </span>
                  </button>
                ))}
                {hosts.length === 0 && <p className="muted small">Add a host first.</p>}
              </div>
            </div>
          </div>
        )}
      </div>

      <div className="transfer-bar">
        <span className="muted small">
          Drag files between panes, or double-click a file to copy it to the other side.
        </span>
        <div className="transfers">
          {transfers.slice(-4).map((t) => (
            <div key={t.key} className={`transfer ${t.state}`} title={t.error}>
              {t.direction === "up" ? <UploadIcon size={14} /> : <DownloadIcon size={14} />}
              <span className="transfer-name">{t.name}</span>
              <progress value={t.done} max={t.total || 1} />
              <span className="muted">
                {t.state === "error"
                  ? "failed"
                  : t.state === "done"
                    ? "done"
                    : `${Math.round((t.done / (t.total || 1)) * 100)}%`}
              </span>
            </div>
          ))}
          {transfers.some((t) => t.state !== "running") && (
            <button className="link small" onClick={() => setTransfers((ts) => ts.filter((t) => t.state === "running"))}>
              Clear
            </button>
          )}
        </div>
      </div>
      {prompt && <PromptDialog request={prompt} onDone={() => setPrompt(null)} />}
    </div>
  );
}
