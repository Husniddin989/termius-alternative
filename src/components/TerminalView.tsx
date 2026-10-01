import { useCallback, useEffect, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import "@xterm/xterm/css/xterm.css";
import { confirm } from "@tauri-apps/plugin-dialog";
import { aiApi, type AiSuggestion, type Snippet, snippetsApi, type SshSession } from "../api";
import { applyInput, completions, emptyLine, type LineState, loadHistory, rememberCommand } from "../completion";
import { hasPlaceholder } from "../snippetLibrary";
import { BoltIcon, CloseIcon, SearchIcon, SparkleIcon } from "./icons";

interface Props {
  session: SshSession;
  active: boolean;
  snippets: Snippet[];
  /** Send recent terminal output along with AI requests. */
  includeOutput: boolean;
  onClosed: (reason: string | null) => void;
  onSnippetSaved: () => void;
}

const IS_MAC = navigator.platform.toUpperCase().includes("MAC");
const AI_SHORTCUT = IS_MAC ? "⌘K" : "Ctrl+Shift+K";

export function TerminalView({ session, active, snippets, includeOutput, onClosed, onSnippetSaved }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const areaRef = useRef<HTMLDivElement>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const termRef = useRef<Terminal | null>(null);
  const onClosedRef = useRef(onClosed);
  onClosedRef.current = onClosed;

  const [panelOpen, setPanelOpen] = useState(false);
  const [query, setQuery] = useState("");

  // ---- Inline completion state -------------------------------------------
  const lineRef = useRef<LineState>(emptyLine);
  const snippetsRef = useRef(snippets);
  snippetsRef.current = snippets;
  const [suggestions, setSuggestions] = useState<string[]>([]);
  const suggestionsRef = useRef<string[]>([]);
  suggestionsRef.current = suggestions;
  const [popupPos, setPopupPos] = useState<{ left: number; top: number; above: boolean } | null>(null);

  // ---- AI bar state -------------------------------------------------------
  const [aiOpen, setAiOpen] = useState(false);
  const [aiPrompt, setAiPrompt] = useState("");
  const [aiBusy, setAiBusy] = useState(false);
  const [aiResult, setAiResult] = useState<AiSuggestion | null>(null);
  const [aiError, setAiError] = useState<string | null>(null);
  const [aiContextLine, setAiContextLine] = useState<string | null>(null);
  const openAiRef = useRef<() => void>(() => {});

  const refreshSuggestions = useCallback(() => {
    const line = lineRef.current;
    setSuggestions(line.known ? completions(line.text, loadHistory(), snippetsRef.current) : []);
  }, []);

  const placePopup = useCallback(() => {
    const term = termRef.current;
    const screen = containerRef.current?.querySelector(".xterm-screen");
    const area = areaRef.current;
    if (!term || !screen || !area) return;
    const rect = screen.getBoundingClientRect();
    const base = area.getBoundingClientRect();
    const cellW = rect.width / term.cols;
    const cellH = rect.height / term.rows;
    const buf = term.buffer.active;
    const left = rect.left - base.left + Math.min(buf.cursorX, term.cols - 30) * cellW;
    const cursorTop = rect.top - base.top + buf.cursorY * cellH;
    const above = buf.cursorY > term.rows - 8;
    setPopupPos({ left: Math.max(8, left), top: above ? cursorTop : cursorTop + cellH + 2, above });
  }, []);

  /** Types text into the shell and keeps our copy of the line in sync. */
  const typeText = useCallback(
    (text: string) => {
      const result = applyInput(lineRef.current, text);
      lineRef.current = result.line;
      if (result.executed) rememberCommand(result.executed);
      session.write(text);
      refreshSuggestions();
    },
    [session, refreshSuggestions],
  );

  const accept = useCallback(
    (cmd: string) => {
      const typed = lineRef.current.text;
      if (cmd.startsWith(typed)) typeText(cmd.slice(typed.length));
      termRef.current?.focus();
    },
    [typeText],
  );

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

    term.attachCustomKeyEventHandler((e) => {
      if (e.type !== "keydown") return true;
      const aiKey = IS_MAC ? e.metaKey && !e.shiftKey : e.ctrlKey && e.shiftKey;
      if (aiKey && e.key.toLowerCase() === "k") {
        openAiRef.current();
        return false;
      }
      const noMods = !e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey;
      if (e.key === "ArrowRight" && noMods && suggestionsRef.current.length > 0) {
        accept(suggestionsRef.current[0]);
        return false;
      }
      if (e.key === "Escape" && suggestionsRef.current.length > 0) {
        lineRef.current = { ...lineRef.current, known: false };
        setSuggestions([]);
      }
      return true;
    });

    const input = term.onData((data) => {
      const result = applyInput(lineRef.current, data);
      lineRef.current = result.line;
      if (result.executed) rememberCommand(result.executed);
      session.write(data);
      refreshSuggestions();
    });
    const cursor = term.onCursorMove(() => {
      if (suggestionsRef.current.length > 0) placePopup();
    });
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
      cursor.dispose();
      resize.dispose();
      session.detach();
      term.dispose();
    };
  }, [session, accept, placePopup, refreshSuggestions]);

  useEffect(() => {
    if (suggestions.length > 0) placePopup();
  }, [suggestions, placePopup]);

  useEffect(() => {
    if (active && !aiOpen) {
      fitRef.current?.fit();
      termRef.current?.focus();
    }
  }, [active, panelOpen, aiOpen]);

  // ---- AI -------------------------------------------------------------------

  const recentOutput = () => {
    const term = termRef.current;
    if (!term) return null;
    const buf = term.buffer.active;
    const end = buf.baseY + buf.cursorY;
    const lines: string[] = [];
    for (let i = Math.max(0, end - 40); i <= end; i++) lines.push(buf.getLine(i)?.translateToString(true) ?? "");
    return lines.join("\n").trim() || null;
  };

  openAiRef.current = () => {
    const line = lineRef.current;
    setAiContextLine(line.known && line.text.trim() ? line.text : null);
    setAiResult(null);
    setAiError(null);
    setAiOpen(true);
  };

  const closeAi = () => {
    setAiOpen(false);
    termRef.current?.focus();
  };

  const askAi = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!aiPrompt.trim() && !aiContextLine) return;
    setAiBusy(true);
    setAiError(null);
    setAiResult(null);
    try {
      setAiResult(
        await aiApi.suggest({
          prompt: aiPrompt.trim() || "Complete the command I have typed.",
          os: session.os,
          currentLine: aiContextLine,
          recentOutput: includeOutput ? recentOutput() : null,
        }),
      );
    } catch (err) {
      setAiError(String(err));
    } finally {
      setAiBusy(false);
    }
  };

  const applyAiCommand = async (run: boolean) => {
    if (!aiResult) return;
    if (run && aiResult.dangerous) {
      const ok = await confirm(`This command may be destructive:\n\n${aiResult.command}\n\nRun it?`, {
        title: "Run command",
        kind: "warning",
      });
      if (!ok) return;
    }
    // Ctrl+U clears whatever is on the prompt before typing the suggestion.
    typeText("\x15" + aiResult.command + (run ? "\r" : ""));
    setAiPrompt("");
    closeAi();
  };

  const saveAiSnippet = async () => {
    if (!aiResult) return;
    await snippetsApi.save({
      id: "",
      name: aiPrompt.trim().slice(0, 60) || aiResult.command.slice(0, 60),
      command: aiResult.command,
      category: "AI",
    });
    onSnippetSaved();
  };

  // ---- Snippets panel -------------------------------------------------------

  const runSnippet = (s: Snippet) => {
    // Commands with <placeholders> are typed but not run, so they can be edited.
    if (hasPlaceholder(s.command)) typeText("\x15" + s.command);
    else typeText(s.command.replace(/\r?\n/g, "\r") + "\r");
    termRef.current?.focus();
  };

  const filtered = snippets.filter((s) =>
    [s.name, s.command, s.category ?? ""].some((v) => v.toLowerCase().includes(query.toLowerCase())),
  );

  return (
    <div className="terminal-wrap" hidden={!active}>
      <div className="terminal-area" ref={areaRef}>
        <div className="term-host" ref={containerRef} />

        <div className="term-buttons">
          <button className="term-btn" onClick={() => openAiRef.current()} title={`Ask AI for a command (${AI_SHORTCUT})`}>
            <SparkleIcon size={16} />
          </button>
          {!panelOpen && (
            <button className="term-btn" onClick={() => setPanelOpen(true)} title="Snippets">
              <BoltIcon size={16} />
            </button>
          )}
        </div>

        {suggestions.length > 0 && popupPos && !aiOpen && (
          <div
            className={`completion ${popupPos.above ? "above" : ""}`}
            style={{ left: popupPos.left, top: popupPos.top }}
          >
            {suggestions.map((cmd, i) => (
              <button
                key={cmd}
                className={i === 0 ? "first" : ""}
                onMouseDown={(e) => {
                  e.preventDefault();
                  accept(cmd);
                }}
              >
                <span className="typed">{lineRef.current.text}</span>
                <span className="rest">{cmd.slice(lineRef.current.text.length)}</span>
                {i === 0 && <kbd>→</kbd>}
              </button>
            ))}
          </div>
        )}

        {aiOpen && (
          <div className="ai-bar" onKeyDown={(e) => e.key === "Escape" && closeAi()}>
            <form onSubmit={askAi} className="ai-input">
              <SparkleIcon size={16} className="ai-mark" />
              <input
                autoFocus
                placeholder={aiContextLine ? `Describe what to do with "${aiContextLine}"…` : "Describe the command you need, in any language…"}
                value={aiPrompt}
                onChange={(e) => setAiPrompt(e.target.value)}
              />
              <button type="submit" className="primary" disabled={aiBusy}>
                {aiBusy ? "Thinking…" : "Ask"}
              </button>
              <button type="button" className="icon-btn" onClick={closeAi} title="Close (Esc)">
                <CloseIcon size={16} />
              </button>
            </form>
            {aiError && <p className="error small">{aiError}</p>}
            {aiResult && (
              <div className="ai-result">
                <code className={aiResult.dangerous ? "danger" : ""}>{aiResult.command}</code>
                <p className="muted small">
                  {aiResult.dangerous && <strong className="warn">⚠ Destructive. </strong>}
                  {aiResult.explanation}
                </p>
                <div className="ai-actions">
                  <button className="secondary" onClick={saveAiSnippet}>
                    Save as snippet
                  </button>
                  <button className="secondary" onClick={() => applyAiCommand(false)}>
                    Insert
                  </button>
                  <button className="primary" onClick={() => applyAiCommand(true)}>
                    Run
                  </button>
                </div>
              </div>
            )}
          </div>
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
              <button
                key={s.id}
                className="snippet-item"
                onClick={() => runSnippet(s)}
                title={hasPlaceholder(s.command) ? "Insert (fill in the <placeholders>)" : "Run in this terminal"}
              >
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
