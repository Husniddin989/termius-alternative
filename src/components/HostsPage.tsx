import { useMemo, useState } from "react";
import type { Host } from "../api";
import { useContextMenu } from "./ContextMenu";
import { OsIcon } from "./OsIcon";
import { ChevronLeft, GridIcon, GroupIcon, ListIcon, PlusIcon, SearchIcon } from "./icons";

interface Props {
  hosts: Host[];
  selectedId: string | null;
  onSelect: (host: Host) => void;
  onConnect: (host: Host) => void;
  onSftp: (host: Host) => void;
  onNew: (group: string | null) => void;
  onDuplicate: (host: Host) => void;
  onDelete: (host: Host) => void;
  onQuickConnect: (host: Host) => void;
}

/** Parses "user@host", "user@host:port" or "ssh user@host -p port". */
export function parseQuickConnect(input: string): Host | null {
  const text = input.trim().replace(/^ssh\s+/, "");
  const portFlag = text.match(/\s-p\s*(\d+)/);
  const target = text.replace(/\s-p\s*\d+/, "").trim();
  const m = target.match(/^([^@\s]+)@([^\s:@]+|\[[^\]]+\])(?::(\d+))?$/);
  if (!m) return null;
  const port = Number(portFlag?.[1] ?? m[3] ?? 22);
  if (!(port > 0 && port < 65536)) return null;
  const host = m[2].replace(/^\[|\]$/g, "");
  return {
    id: "",
    label: `${m[1]}@${host}`,
    host,
    port,
    username: m[1],
    authMethod: "password",
    keyPath: null,
    group: null,
    jumpHostId: null,
    os: null,
  };
}

export function HostsPage(props: Props) {
  const { hosts, selectedId, onSelect, onConnect, onSftp, onNew, onDuplicate, onDelete, onQuickConnect } = props;
  const [query, setQuery] = useState("");
  const [group, setGroup] = useState<string | null>(null);
  const [layout, setLayout] = useState<"grid" | "list">("grid");
  const menu = useContextMenu();
  const quick = parseQuickConnect(query);

  const groups = useMemo(() => {
    const counts = new Map<string, number>();
    for (const h of hosts) if (h.group) counts.set(h.group, (counts.get(h.group) ?? 0) + 1);
    return [...counts.entries()].sort(([a], [b]) => a.localeCompare(b));
  }, [hosts]);

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (q) {
      return hosts.filter((h) =>
        [h.label, h.host, h.username, h.group ?? ""].some((v) => v.toLowerCase().includes(q)),
      );
    }
    return hosts.filter((h) => (group ? h.group === group : !h.group));
  }, [hosts, query, group]);

  const sorted = [...visible].sort((a, b) => a.label.localeCompare(b.label));
  const showGroups = !query.trim() && !group && groups.length > 0;

  const hostMenu = (e: React.MouseEvent, h: Host) =>
    menu.open(e, [
      { label: "Connect", onClick: () => onConnect(h) },
      { label: "Open SFTP", onClick: () => onSftp(h) },
      { label: "Edit", onClick: () => onSelect(h) },
      { label: "Duplicate", onClick: () => onDuplicate(h) },
      { label: "Delete", onClick: () => onDelete(h), danger: true },
    ]);

  return (
    <div className="page">
      <form
        className="omnibar"
        onSubmit={(e) => {
          e.preventDefault();
          if (quick) onQuickConnect(quick);
          else if (sorted.length === 1) onConnect(sorted[0]);
        }}
      >
        <SearchIcon size={16} className="muted" />
        <input
          placeholder="Search hosts, or type user@host to connect"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        {(quick || (query && sorted.length === 1)) && (
          <button type="submit" className="omnibar-connect">
            Connect ↵
          </button>
        )}
      </form>

      <div className="toolbar">
        <button className="toolbar-btn" onClick={() => onNew(group)}>
          <PlusIcon size={16} /> New host
        </button>
        <div className="spacer" />
        <button className={`icon-btn ${layout === "grid" ? "on" : ""}`} onClick={() => setLayout("grid")} title="Grid">
          <GridIcon size={17} />
        </button>
        <button className={`icon-btn ${layout === "list" ? "on" : ""}`} onClick={() => setLayout("list")} title="List">
          <ListIcon size={17} />
        </button>
      </div>

      <div className="page-scroll">
        {group && !query.trim() && (
          <div className="crumbs">
            <button className="link" onClick={() => setGroup(null)}>
              <ChevronLeft size={16} /> Hosts
            </button>
            <span className="muted">/</span>
            <strong>{group}</strong>
          </div>
        )}

        {showGroups && (
          <>
            <h2 className="section-title">Groups</h2>
            <div className={`cards ${layout}`}>
              {groups.map(([name, count]) => (
                <div key={name} className="card" onClick={() => setGroup(name)}>
                  <span className="group-icon">
                    <GroupIcon size={22} />
                  </span>
                  <div className="card-text">
                    <strong>{name}</strong>
                    <span>
                      {count} {count === 1 ? "Host" : "Hosts"}
                    </span>
                  </div>
                </div>
              ))}
            </div>
          </>
        )}

        {(sorted.length > 0 || !showGroups) && <h2 className="section-title">Hosts</h2>}
        {hosts.length === 0 && (
          <div className="empty-state">
            <p>No hosts yet. Add one, or type <code>ssh user@hostname</code> above to connect right away.</p>
            <button className="primary" onClick={() => onNew(null)}>
              <PlusIcon size={16} /> New host
            </button>
          </div>
        )}
        {hosts.length > 0 && sorted.length === 0 && (
          <p className="muted">{query ? "No hosts match your search." : "No hosts in this group."}</p>
        )}
        <div className={`cards ${layout}`}>
          {sorted.map((h) => (
            <div
              key={h.id}
              className={`card ${selectedId === h.id ? "selected" : ""}`}
              onClick={() => onSelect(h)}
              onDoubleClick={() => onConnect(h)}
              onContextMenu={(e) => hostMenu(e, h)}
              title="Double-click to connect"
            >
              <OsIcon os={h.os} />
              <div className="card-text">
                <strong>{h.label}</strong>
                <span>
                  {h.username}@{h.host}
                  {h.port !== 22 && `:${h.port}`}
                  {h.jumpHostId && ` · via ${hosts.find((j) => j.id === h.jumpHostId)?.label ?? "?"}`}
                </span>
              </div>
            </div>
          ))}
        </div>
      </div>
      {menu.element}
    </div>
  );
}
