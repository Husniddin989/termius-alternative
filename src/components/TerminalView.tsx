import { useCallback, useEffect, useRef, useState } from "react";
import { type ITheme, Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import "@xterm/xterm/css/xterm.css";
import { confirm } from "@tauri-apps/plugin-dialog";
import { aiApi, type AiSuggestion, type Snippet, snippetsApi, type SshSession } from "../api";
import {
  applyInput,
  cwdAfter,
  cwdFromPrompt,
  emptyLine,
  type LineState,
  loadHistory,
  rememberCommand,
  suggest,
  type Suggestion,
} from "../completion";
import { hasPlaceholder } from "../snippetLibrary";
import { BoltIcon, CloseIcon, SearchIcon, SparkleIcon } from "./icons";
import { IS_MOBILE } from "../platform";
import { attachTouchScroll } from "../touchScroll";

/** Ctrl+key for a single typed character, e.g. "c" → ETX (Ctrl+C). */
function withCtrl(ch: string): string {
  if (/^[a-z]$/i.test(ch)) return String.fromCharCode(ch.toUpperCase().charCodeAt(0) & 0x1f);
  const special: Record<string, string> = { "[": "\x1b", "\\": "\x1c", "]": "\x1d", " ": "\x00", "/": "\x1f" };
  return special[ch] ?? ch;
}

interface Props {
  session: SshSession;
  active: boolean;
  snippets: Snippet[];
  /** Send recent terminal output along with AI requests. */
  includeOutput: boolean;
  /** Colours of the current UI theme. */
  termTheme: ITheme;
  /** Which model answers, shown in the AI bar. */
  aiLabel: string;
  onClosed: (reason: string | null) => void;
  /** Opens a new connection for this tab; the terminal and its scrollback stay. */
  onReconnect?: () => void;
  onSnippetSaved: () => void;
}

const IS_MAC = navigator.platform.toUpperCase().includes("MAC");

const KIND_MARK: Record<Suggestion["kind"], string> = {
  history: "↺",
  command: "$",
  subcommand: "›",
  option: "-",
  dir: "▸",
  file: "·",
};
const AI_SHORTCUT = IS_MAC ? "⌘K" : "Ctrl+Shift+K";

export function TerminalView({
  session,
  active,
  snippets,
  includeOutput,
  termTheme,
  aiLabel,
  onClosed,
  onReconnect,
  onSnippetSaved,
}: Props) {
  const initialTheme = useRef(termTheme);
  const containerRef = useRef<HTMLDivElement>(null);
  const areaRef = useRef<HTMLDivElement>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const termRef = useRef<Terminal | null>(null);
  const onClosedRef = useRef(onClosed);
  onClosedRef.current = onClosed;
  const onReconnectRef = useRef(onReconnect);
  onReconnectRef.current = onReconnect;
  // The session can be replaced (reconnect) while the terminal lives on.
  const sessionRef = useRef(session);
  sessionRef.current = session;
  /** undefined while connected; the close reason (or null) after. */
  const [closed, setClosed] = useState<string | null | undefined>(undefined);
  const closedRef = useRef(closed);
  closedRef.current = closed;

  const [panelOpen, setPanelOpen] = useState(false);
  const [query, setQuery] = useState("");

  // ---- Inline completion state -------------------------------------------
  const lineRef = useRef<LineState>(emptyLine);
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
  const suggestionsRef = useRef<Suggestion[]>([]);
  suggestionsRef.current = suggestions;
  const [selected, setSelected] = useState(0);
  const selectedRef = useRef(0);
  selectedRef.current = selected;
  /** Shell history from the server, oldest first. */
  const remoteHistoryRef = useRef<string[]>([]);
  /** The shell's working directory as far as we can tell (prompt, or `cd`s typed). */
  const cwdRef = useRef<string | null>("~");
  const listingsRef = useRef(new Map<string, { entries: string[]; at: number }>());
  const loadingRef = useRef(new Set<string>());
  const [popupPos, setPopupPos] = useState<{ left: number; top: number; above: boolean } | null>(null);

  // ---- AI bar state -------------------------------------------------------
  const [aiOpen, setAiOpen] = useState(false);
  const [aiPrompt, setAiPrompt] = useState("");
  const [aiBusy, setAiBusy] = useState(false);
  const [aiResult, setAiResult] = useState<AiSuggestion | null>(null);
  const [aiError, setAiError] = useState<string | null>(null);
  const [aiContextLine, setAiContextLine] = useState<string | null>(null);
  const openAiRef = useRef<() => void>(() => {});

  // ---- Phone extra-keys bar: a sticky Ctrl applies to the next typed key ----
  const ctrlRef = useRef(false);
  const [ctrlOn, setCtrlOn] = useState(false);
  const setCtrl = (on: boolean) => {
    ctrlRef.current = on;
    setCtrlOn(on);
  };

  const refreshSuggestions = useCallback(() => {
    const line = lineRef.current;
    if (!line.known) {
      setSuggestions([]);
      return;
    }
    const listings = listingsRef.current;
    const result = suggest(line.text, {
      history: [...remoteHistoryRef.current, ...loadHistory()],
      cwd: cwdRef.current,
      listing: (dir) => {
        const hit = listings.get(dir);
        return hit && Date.now() - hit.at < 15_000 ? hit.entries : undefined;
      },
    });
    setSuggestions(result.items);
    setSelected(0);
    // Fetch the directory in the background; suggestions update when it arrives.
    const dir = result.need;
    if (dir && !loadingRef.current.has(dir)) {
      loadingRef.current.add(dir);
      sessionRef.current
        .listDir(dir)
        .catch(() => [] as string[])
        .then((entries) => {
          listings.set(dir, { entries, at: Date.now() });
          loadingRef.current.delete(dir);
          // The user may have typed on meanwhile; recompute for the current line.
          if (lineRef.current.known && lineRef.current.text) refreshSuggestions();
        });
    }
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

  const onExecuted = (command: string) => {
    rememberCommand(command);
    cwdRef.current = cwdAfter(cwdRef.current, command);
  };

  /** Types text into the shell and keeps our copy of the line in sync. */
  const typeText = useCallback(
    (text: string) => {
      const result = applyInput(lineRef.current, text);
      lineRef.current = result.line;
      if (result.executed) onExecuted(result.executed);
      sessionRef.current.write(text);
      refreshSuggestions();
    },
    [refreshSuggestions],
  );

  const accept = useCallback(
    (item: Suggestion) => {
      typeText(item.insert);
      termRef.current?.focus();
    },
    [typeText],
  );

  useEffect(() => {
    const term = new Terminal({
      cursorBlink: true,
      fontFamily: '"JetBrains Mono", "SF Mono", Menlo, "Cascadia Code", Consolas, monospace',
      fontSize: IS_MOBILE ? 13 : 14,
      lineHeight: 1.15,
      theme: initialTheme.current,
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
      const items = suggestionsRef.current;
      if (items.length > 0 && noMods) {
        if (e.key === "ArrowRight" || e.key === "Tab") {
          e.preventDefault();
          accept(items[Math.min(selectedRef.current, items.length - 1)]);
          return false;
        }
        if ((e.key === "ArrowDown" || e.key === "ArrowUp") && items.length > 1) {
          e.preventDefault();
          const step = e.key === "ArrowDown" ? 1 : -1;
          setSelected((i) => (i + step + items.length) % items.length);
          return false;
        }
        if (e.key === "Escape") {
          lineRef.current = { ...lineRef.current, known: false };
          setSuggestions([]);
        }
      }
      return true;
    });

    const input = term.onData((typed) => {
      if (closedRef.current !== undefined) {
        if (typed === "\r") onReconnectRef.current?.();
        return;
      }
      let data = typed;
      if (ctrlRef.current && typed.length === 1) {
        data = withCtrl(typed);
        ctrlRef.current = false;
        setCtrlOn(false);
      }
      const result = applyInput(lineRef.current, data);
      lineRef.current = result.line;
      if (result.executed) onExecuted(result.executed);
      sessionRef.current.write(data);
      refreshSuggestions();
    });
    const cursor = term.onCursorMove(() => {
      if (suggestionsRef.current.length > 0) placePopup();
      // At an empty prompt, read the working directory from it (user@host:~/dir$).
      const line = lineRef.current;
      if (line.known && line.text === "") {
        const buf = term.buffer.active;
        const text = buf.getLine(buf.baseY + buf.cursorY)?.translateToString(true) ?? "";
        const cwd = cwdFromPrompt(text.slice(0, buf.cursorX));
        if (cwd) cwdRef.current = cwd;
      }
    });
    const resize = term.onResize(({ cols, rows }) => {
      if (closedRef.current === undefined) void sessionRef.current.resize(cols, rows);
    });

    const observer = new ResizeObserver(() => fit.fit());
    observer.observe(containerRef.current!);
    const detachTouch = IS_MOBILE
      ? attachTouchScroll(containerRef.current!, term, (d) => void sessionRef.current.write(d))
      : null;

    return () => {
      detachTouch?.();
      observer.disconnect();
      input.dispose();
      cursor.dispose();
      resize.dispose();
      term.dispose();
    };
  }, [accept, placePopup, refreshSuggestions]);

  // Connect the terminal to the current session (again after a reconnect).
  useEffect(() => {
    const term = termRef.current!;
    setClosed(undefined);
    closedRef.current = undefined;
    lineRef.current = emptyLine;
    cwdRef.current = "~";
    listingsRef.current.clear();
    remoteHistoryRef.current = [];
    void session.history().then(
      (h) => (remoteHistoryRef.current = h),
      () => {},
    );
    fitRef.current?.fit();
    void session.resize(term.cols, term.rows);
    session.attach({
      onData: (bytes) => term.write(bytes),
      onClosed: (reason) => {
        term.write(`\r\n\x1b[33m[connection closed${reason ? `: ${reason}` : ""}]\x1b[0m\r\n`);
        closedRef.current = reason;
        setClosed(reason);
        setSuggestions([]);
        onClosedRef.current(reason);
      },
    });
    return () => session.detach();
  }, [session]);

  useEffect(() => {
    if (suggestions.length > 0) placePopup();
  }, [suggestions, placePopup]);

  useEffect(() => {
    if (termRef.current) termRef.current.options.theme = termTheme;
  }, [termTheme]);

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

        {closed !== undefined && onReconnect && (
          <div className="reconnect-bar">
            <span>Disconnected{closed ? ` — ${closed}` : ""}</span>
            <button className="primary" onClick={onReconnect}>
              Reconnect
            </button>
            {!IS_MOBILE && <span className="muted small">or press Enter</span>}
          </div>
        )}

        <div className="term-buttons" hidden={IS_MOBILE}>
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
            {suggestions.map((item, i) => (
              <button
                key={item.kind + item.label}
                className={i === selected ? "first" : ""}
                onMouseDown={(e) => {
                  e.preventDefault();
                  accept(item);
                }}
              >
                <span className={`kind ${item.kind}`}>{KIND_MARK[item.kind]}</span>
                <span className="label">{item.label}</span>
                {item.detail && <span className="detail">{item.detail}</span>}
                {i === selected && <kbd>{IS_MOBILE ? "tap" : "→"}</kbd>}
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
            {aiBusy && <p className="muted small">Asking {aiLabel}… local models can take a few seconds.</p>}
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

      {IS_MOBILE && (
        <div className="keybar" role="toolbar" aria-label="Extra keys">
          {(
            [
              ["Esc", "\x1b"],
              ["Tab", "\t"],
              ["Ctrl", null],
              ["←", "D"],
              ["↑", "A"],
              ["↓", "B"],
              ["→", "C"],
              ["|", "|"],
              ["/", "/"],
              ["-", "-"],
              ["~", "~"],
            ] as [string, string | null][]
          ).map(([label, seq]) => (
            <button
              key={label}
              className={label === "Ctrl" && ctrlOn ? "on" : ""}
              // Keep focus (and the on-screen keyboard) on the terminal.
              onPointerDown={(e) => e.preventDefault()}
              onClick={() => {
                const term = termRef.current;
                if (!term) return;
                if (seq === null) return setCtrl(!ctrlRef.current);
                if (label === "→" && suggestionsRef.current.length > 0)
                  return accept(suggestionsRef.current[selectedRef.current] ?? suggestionsRef.current[0]);
                const isArrow = ["←", "↑", "↓", "→"].includes(label);
                const out = isArrow ? (term.modes.applicationCursorKeysMode ? "\x1bO" : "\x1b[") + seq : seq;
                if (ctrlRef.current && out.length === 1) {
                  setCtrl(false);
                  typeText(withCtrl(out));
                } else {
                  typeText(out);
                }
                term.focus();
              }}
            >
              {label}
            </button>
          ))}
        </div>
      )}

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
