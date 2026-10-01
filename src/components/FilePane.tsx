import { useState } from "react";
import type { SftpEntry } from "../api";
import { useContextMenu, type MenuItem } from "./ContextMenu";
import { ArrowUp, FileIcon, FolderIcon, LinkIcon, RefreshIcon } from "./icons";

export type Side = "local" | "remote";

/** Payload carried when dragging files between panes. */
export interface DragFile {
  from: Side;
  entry: SftpEntry;
}

interface Props {
  side: Side;
  title: React.ReactNode;
  headerActions?: React.ReactNode;
  path: string;
  entries: SftpEntry[];
  loading: boolean;
  error: string | null;
  onNavigate: (path: string) => void;
  onParent: () => void;
  onRefresh: () => void;
  /** Double-click on a file (directories always navigate). */
  onOpenFile: (entry: SftpEntry) => void;
  /** A file from the other pane was dropped here. */
  onDrop: (file: DragFile) => void;
  menuFor: (entry: SftpEntry) => MenuItem[];
  extraRows?: React.ReactNode;
}

function formatSize(n: number) {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let i = 0;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i++;
  }
  return `${i === 0 ? n : n.toFixed(1)} ${units[i]}`;
}

function formatDate(secs: number | null) {
  if (!secs) return "";
  const d = new Date(secs * 1000);
  return d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" }) +
    ", " + d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
}

export function FilePane(props: Props) {
  const { side, title, headerActions, path, entries, loading, error, onNavigate, onParent, onRefresh } = props;
  const [pathInput, setPathInput] = useState(path);
  const [editingPath, setEditingPath] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const menu = useContextMenu();

  return (
    <div
      className={`pane ${dragOver ? "drag-over" : ""}`}
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes("application/x-sftp-file")) {
          e.preventDefault();
          setDragOver(true);
        }
      }}
      onDragLeave={() => setDragOver(false)}
      onDrop={(e) => {
        setDragOver(false);
        const raw = e.dataTransfer.getData("application/x-sftp-file");
        if (!raw) return;
        const file = JSON.parse(raw) as DragFile;
        if (file.from !== side) props.onDrop(file);
      }}
    >
      <div className="pane-head">
        <div className="pane-title">{title}</div>
        <div className="pane-actions">{headerActions}</div>
      </div>
      <div className="pane-path">
        <button className="icon-btn" onClick={onParent} title="Parent folder">
          <ArrowUp size={16} />
        </button>
        <button className="icon-btn" onClick={onRefresh} title="Refresh">
          <RefreshIcon size={16} />
        </button>
        {editingPath ? (
          <form
            className="grow"
            onSubmit={(e) => {
              e.preventDefault();
              setEditingPath(false);
              onNavigate(pathInput);
            }}
          >
            <input autoFocus value={pathInput} onChange={(e) => setPathInput(e.target.value)} onBlur={() => setEditingPath(false)} />
          </form>
        ) : (
          <button
            className="path-text grow"
            onClick={() => {
              setPathInput(path);
              setEditingPath(true);
            }}
            title="Click to type a path"
          >
            {path}
          </button>
        )}
      </div>

      {error && <p className="error small pad-x">{error}</p>}

      <div className="file-table">
        <div className="file-row head">
          <span>Name</span>
          <span>Date modified</span>
          <span>Size</span>
        </div>
        {props.extraRows}
        {loading && entries.length === 0 && <p className="muted small pad-x">Loading…</p>}
        {!loading && !error && entries.length === 0 && <p className="muted small pad-x">Empty folder</p>}
        {entries.map((e) => (
          <div
            key={e.path}
            className={`file-row ${selected === e.path ? "selected" : ""}`}
            draggable={!e.isDir}
            onDragStart={(ev) => {
              ev.dataTransfer.setData("application/x-sftp-file", JSON.stringify({ from: side, entry: e } satisfies DragFile));
              ev.dataTransfer.effectAllowed = "copy";
            }}
            onClick={() => setSelected(e.path)}
            onDoubleClick={() => (e.isDir ? onNavigate(e.path) : props.onOpenFile(e))}
            onContextMenu={(ev) => {
              setSelected(e.path);
              menu.open(ev, props.menuFor(e));
            }}
          >
            <span className="file-name">
              {e.isDir ? (
                <FolderIcon size={16} className="folder" />
              ) : e.isSymlink ? (
                <LinkIcon size={16} />
              ) : (
                <FileIcon size={16} />
              )}
              <span>{e.name}</span>
            </span>
            <span className="muted">{formatDate(e.modified)}</span>
            <span className="muted">{e.isDir ? "--" : formatSize(e.size)}</span>
          </div>
        ))}
      </div>
      {menu.element}
    </div>
  );
}
