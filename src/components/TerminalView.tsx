import { useEffect, useRef } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import "@xterm/xterm/css/xterm.css";
import type { SshSession } from "../api";

interface Props {
  session: SshSession;
  active: boolean;
  onClosed: (reason: string | null) => void;
}

export function TerminalView({ session, active, onClosed }: Props) {
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

  return <div className="terminal" ref={containerRef} hidden={!active} />;
}
