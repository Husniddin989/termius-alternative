import { useEffect, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import "@xterm/xterm/css/xterm.css";
import type { Snippet, SshSession } from "../api";

interface Props {
  session: SshSession;
  active: boolean;
  snippets: Snippet[];
  onClosed: (reason: string | null) => void;
}

export function TerminalView({ session, active, snippets, onClosed }: Props) {
  const [paletteOpen, setPaletteOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const termRef = useRef<Terminal | null>(null);
  const onClosedRef = useRef(onClosed);
  onClosedRef.current = onClosed;

  useEffect(() => {
    const term = new Terminal({
      cursorBlink: true,
      fontFamily: '"JetBrains Mono", "Cascadia Code", Menlo, Consolas, monospace',
      fontSize: 14,
      theme: { background: "#141821", foreground: "#d8dee9", cursor: "#5ec4ff" },
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
  }, [active]);

  const runSnippet = (s: Snippet) => {
    setPaletteOpen(false);
    session.write(s.command.replace(/\r?\n/g, "\r") + "\r");
    termRef.current?.focus();
  };

  return (
    <div className="terminal-wrap" hidden={!active}>
      <div className="terminal" ref={containerRef} />
      <div className="palette">
        <button className="ghost" onClick={() => setPaletteOpen((o) => !o)} title="Snippets">
          ⚡
        </button>
        {paletteOpen && (
          <div className="palette-menu">
            {snippets.length === 0 && <p className="muted">No snippets yet — add them in the Snippets tab.</p>}
            {snippets.map((s) => (
              <button key={s.id} className="ghost" onClick={() => runSnippet(s)} title={s.command}>
                {s.name}
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
