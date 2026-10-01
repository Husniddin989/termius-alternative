import { useEffect, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import "@xterm/xterm/css/xterm.css";
import type { Snippet, SshSession } from "../api";
import { BoltIcon, CloseIcon, SearchIcon } from "./icons";

interface Props {
  session: SshSession;
  active: boolean;
  snippets: Snippet[];
  onClosed: (reason: string | null) => void;
}

export function TerminalView({ session, active, snippets, onClosed }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const termRef = useRef<Terminal | null>(null);
  const onClosedRef = useRef(onClosed);
  onClosedRef.current = onClosed;
  const [panelOpen, setPanelOpen] = useState(false);
  const [query, setQuery] = useState("");

  useEffect(() => {
    const term = new Terminal({
      cursorBlink: true,
      fontFamily: '"JetBrains Mono", "SF Mono", Menlo, "Cascadia Code", Consolas, monospace',
      fontSize: 14,
      lineHeight: 1.15,
      theme: {
        background: "#0f1115",
        foreground: "#d6dae2",
        cursor: "#2dd4bf",
        selectionBackground: "#2dd4bf44",
      },
      allowProposedApi: true,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.loadAddon(new WebLinksAddon());
    term.open(containerRef.current!);
    fit.fit();
    fitRef.current = fit;
    termRef.current = term;

    const input = term.onData((text) => void session.write(text));
    const resize = term.onResize(({ cols, rows }) => void session.resize(cols, rows));
    session.resize(term.cols, term.rows);
    session.attach({
      onData: (bytes) => term.write(bytes),
      onClosed: (reason) => {
        term.write(`\r\n\x1b[33m[connection closed${reason ? `: ${reason}` : ""}]\x1b[0m\r\n`);
        onClosedRef.current(reason);
      },
    });

    const observer = new ResizeObserver(() => fit.fit());
    observer.observe(containerRef.current!);

    return () => {
      observer.disconnect();
      input.dispose();
      resize.dispose();
      session.detach();
      term.dispose();
    };
  }, [session]);

  useEffect(() => {
    if (active) {
      fitRef.current?.fit();
      termRef.current?.focus();
    }
  }, [active, panelOpen]);

  const runSnippet = (s: Snippet) => {
    session.write(s.command.replace(/\r?\n/g, "\r") + "\r");
    termRef.current?.focus();
  };

  const filtered = snippets.filter((s) =>
    [s.name, s.command].some((v) => v.toLowerCase().includes(query.toLowerCase())),
  );

  return (
    <div className="terminal-wrap" hidden={!active}>
      <div className="terminal-area">
        <div className="term-host" ref={containerRef} />
        {!panelOpen && (
          <button className="snippet-toggle" onClick={() => setPanelOpen(true)} title="Snippets">
            <BoltIcon size={16} />
          </button>
        )}
      </div>
      {panelOpen && (
        <aside className="snippet-panel">
          <header>
            <strong>Snippets</strong>
            <button className="icon-btn" onClick={() => setPanelOpen(false)} title="Close">
              <CloseIcon size={16} />
            </button>
          </header>
          <label className="field">
            <span className="field-icon">
              <SearchIcon size={15} />
            </span>
            <input placeholder="Filter" value={query} onChange={(e) => setQuery(e.target.value)} />
          </label>
          <div className="snippet-list">
            {snippets.length === 0 && <p className="muted small">No snippets yet. Add some in the Snippets section.</p>}
            {filtered.map((s) => (
              <button key={s.id} className="snippet-item" onClick={() => runSnippet(s)} title="Run in this terminal">
                <strong>{s.name}</strong>
                <code>{s.command.split("\n")[0]}</code>
              </button>
            ))}
          </div>
        </aside>
      )}
    </div>
  );
}
