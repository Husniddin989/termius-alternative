import { useCallback, useEffect, useRef, useState } from "react";
import { confirm, open, save } from "@tauri-apps/plugin-dialog";
import { type SftpEntry, sftpApi } from "../api";

interface Props {
  sftpId: string;
  home: string;
  active: boolean;
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

const joinPath = (dir: string, name: string) => (dir.endsWith("/") ? dir + name : `${dir}/${name}`);
const parentOf = (path: string) => path.replace(/\/[^/]+\/?$/, "") || "/";
const baseName = (path: string) => path.split(/[\\/]/).pop() ?? path;

function formatSize(n: number) {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let i = 0;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i++;
  }
  return `${i === 0 ? n : n.toFixed(1)} ${units[i]}`;
}

function formatMode(mode: number | null, isDir: boolean) {
  if (mode === null) return "";
  const bits = "rwxrwxrwx";
  let s = isDir ? "d" : "-";
  for (let i = 0; i < 9; i++) s += mode & (1 << (8 - i)) ? bits[i] : "-";
  return s;
}

let transferSeq = 0;

export function SftpView({ sftpId, home, active }: Props) {
  const [path, setPath] = useState(home);
  const pathRef = useRef(home);
  pathRef.current = path;
  const [pathInput, setPathInput] = useState(home);
  const [entries, setEntries] = useState<SftpEntry[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<{ path: string; name: string } | null>(null);
  const [newFolder, setNewFolder] = useState<string | null>(null);
  const [transfers, setTransfers] = useState<Transfer[]>([]);

  const load = useCallback(
    async (dir: string) => {
      setLoading(true);
      try {
        setEntries(await sftpApi.list(sftpId, dir));
        setPath(dir);
        setPathInput(dir);
        setSelected(null);
        setError(null);
      } catch (e) {
        setError(String(e));
      } finally {
        setLoading(false);
      }
    },
    [sftpId],
  );

  useEffect(() => {
    load(home);
  }, [load, home]);

  const run = async (op: () => Promise<unknown>) => {
    try {
      await op();
      await load(path);
    } catch (e) {
      setError(String(e));
    }
  };

  const track = async (
    name: string,
    direction: Transfer["direction"],
    op: (onProgress: (p: { done: number; total: number }) => void) => Promise<void>,
  ) => {
    const key = ++transferSeq;
    const update = (patch: Partial<Transfer>) =>
      setTransfers((ts) => ts.map((t) => (t.key === key ? { ...t, ...patch } : t)));
    setTransfers((ts) => [...ts, { key, name, direction, done: 0, total: 0, state: "running" }]);
    try {
      await op((p) => update({ done: p.done, total: p.total }));
      update({ state: "done" });
    } catch (e) {
      update({ state: "error", error: String(e) });
    }
  };

  const upload = async () => {
    const picked = await open({ multiple: true, directory: false });
    if (!picked) return;
    const files = Array.isArray(picked) ? picked : [picked];
    const dir = path;
    await Promise.all(
      files.map((local) =>
        track(baseName(local), "up", (p) => sftpApi.upload(sftpId, local, joinPath(dir, baseName(local)), p)),
      ),
    );
    // Refresh only if the user is still looking at the folder we uploaded into.
    if (pathRef.current === dir) load(dir);
  };

  const download = async (entry: SftpEntry) => {
    const local = await save({ defaultPath: entry.name });
    if (!local) return;
    track(entry.name, "down", (p) => sftpApi.download(sftpId, entry.path, local, p));
  };

  const remove = async (entry: SftpEntry) => {
    const what = entry.isDir ? `folder "${entry.name}" and everything in it` : `"${entry.name}"`;
    if (!(await confirm(`Delete ${what}?`, { title: "Delete", kind: "warning" }))) return;
    run(() => sftpApi.remove(sftpId, entry.path, entry.isDir));
  };

  const open_ = (entry: SftpEntry) => (entry.isDir ? load(entry.path) : download(entry));
  const current = entries.find((e) => e.path === selected) ?? null;

  return (
    <div className="sftp" hidden={!active}>
      <div className="sftp-toolbar">
        <button className="ghost" onClick={() => load(parentOf(path))} disabled={path === "/"} title="Up">
          ↑
        </button>
        <button className="ghost" onClick={() => load(path)} title="Refresh">
          ⟳
        </button>
        <form
          className="grow"
          onSubmit={(e) => {
            e.preventDefault();
            load(pathInput);
          }}
        >
          <input value={pathInput} onChange={(e) => setPathInput(e.target.value)} />
        </form>
        <button className="ghost" onClick={() => setNewFolder("")}>
          New folder
        </button>
        <button onClick={upload}>Upload</button>
      </div>

      {error && <p className="error sftp-error">{error}</p>}

      <div className="sftp-table">
        <div className="sftp-row head">
          <span>Name</span>
          <span>Size</span>
          <span>Modified</span>
          <span>Permissions</span>
          <span />
        </div>
        {newFolder !== null && (
          <form
            className="sftp-row"
            onSubmit={(e) => {
              e.preventDefault();
              const name = newFolder.trim();
              setNewFolder(null);
              if (name) run(() => sftpApi.mkdir(sftpId, joinPath(path, name)));
            }}
          >
            <input autoFocus placeholder="Folder name" value={newFolder} onChange={(e) => setNewFolder(e.target.value)} onBlur={() => setNewFolder(null)} />
          </form>
        )}
        {loading && entries.length === 0 && <p className="muted pad">Loading…</p>}
        {!loading && entries.length === 0 && !error && <p className="muted pad">This folder is empty.</p>}
        {entries.map((e) => (
          <div
            key={e.path}
            className={`sftp-row ${selected === e.path ? "selected" : ""}`}
            onClick={() => setSelected(e.path)}
            onDoubleClick={() => open_(e)}
          >
            {renaming?.path === e.path ? (
              <form
                onSubmit={(ev) => {
                  ev.preventDefault();
                  const name = renaming.name.trim();
                  setRenaming(null);
                  if (name && name !== e.name) run(() => sftpApi.rename(sftpId, e.path, joinPath(path, name)));
                }}
              >
                <input
                  autoFocus
                  value={renaming.name}
                  onChange={(ev) => setRenaming({ path: e.path, name: ev.target.value })}
                  onBlur={() => setRenaming(null)}
                />
              </form>
            ) : (
              <span className="name">
                <span className="icon">{e.isDir ? "📁" : e.isSymlink ? "🔗" : "📄"}</span>
                {e.name}
              </span>
            )}
            <span className="muted">{e.isDir ? "" : formatSize(e.size)}</span>
            <span className="muted">{e.modified ? new Date(e.modified * 1000).toLocaleString() : ""}</span>
            <span className="muted mono">{formatMode(e.permissions, e.isDir)}</span>
            <span className="row-actions">
              {!e.isDir && (
                <button className="ghost" onClick={() => download(e)} title="Download">
                  ↓
                </button>
              )}
              <button className="ghost" onClick={() => setRenaming({ path: e.path, name: e.name })} title="Rename">
                ✎
              </button>
              <button className="ghost danger" onClick={() => remove(e)} title="Delete">
                ✕
              </button>
            </span>
          </div>
        ))}
      </div>

      <div className="sftp-status">
        <span className="muted">
          {entries.length} items{current ? ` · ${current.name}` : ""}
        </span>
        {transfers.length > 0 && (
          <div className="transfers">
            {transfers.slice(-4).map((t) => (
              <div key={t.key} className={`transfer ${t.state}`} title={t.error}>
                <span>
                  {t.direction === "up" ? "↑" : "↓"} {t.name}
                </span>
                <progress value={t.done} max={t.total || 1} />
                <span className="muted">
                  {t.state === "error" ? "failed" : t.state === "done" ? "done" : `${Math.round((t.done / (t.total || 1)) * 100)}%`}
                </span>
              </div>
            ))}
            <button className="ghost" onClick={() => setTransfers((ts) => ts.filter((t) => t.state === "running"))}>
              Clear
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
