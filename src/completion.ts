import type { Snippet } from "./api";

/**
 * Best-effort copy of what the user is typing on the shell prompt, built
 * from the keystrokes we send. Once something we can't follow happens
 * (arrow keys, Tab completion, history recall) the line is marked unknown
 * until the next Enter or Ctrl+C, and no suggestions are shown.
 */
export interface LineState {
  text: string;
  known: boolean;
}

export const emptyLine: LineState = { text: "", known: true };

const PASTE_START = "\x1b[200~";
const PASTE_END = "\x1b[201~";

/** Applies terminal input; returns the new line and the command run by Enter, if any. */
export function applyInput(line: LineState, data: string): { line: LineState; executed: string | null } {
  let { text, known } = line;
  let executed: string | null = null;

  if (data.startsWith(PASTE_START)) {
    data = data.slice(PASTE_START.length).replace(PASTE_END, "");
  } else if (data.startsWith("\x1b")) {
    return { line: { text, known: false }, executed };
  }

  for (const ch of data) {
    switch (ch) {
      case "\r":
      case "\n":
        if (known && text.trim()) executed = text.trim();
        text = "";
        known = true;
        break;
      case "\x7f":
      case "\b":
        text = text.slice(0, -1);
        break;
      case "\x03": // Ctrl+C
      case "\x15": // Ctrl+U
        text = "";
        known = true;
        break;
      case "\x17": // Ctrl+W: delete previous word
        text = text.replace(/\S+\s*$/, "");
        break;
      default:
        if (ch < " ") known = false; // Tab, Ctrl+R, Ctrl+A…
        else text += ch;
    }
  }
  return { line: { text, known }, executed };
}

const HISTORY_KEY = "commandHistory";
const HISTORY_MAX = 500;

export function loadHistory(): string[] {
  try {
    const raw = localStorage.getItem(HISTORY_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed.filter((x) => typeof x === "string") : [];
  } catch {
    return [];
  }
}

/** Records a command (most recent last, without duplicates). */
export function rememberCommand(command: string) {
  const history = loadHistory().filter((c) => c !== command);
  history.push(command);
  try {
    localStorage.setItem(HISTORY_KEY, JSON.stringify(history.slice(-HISTORY_MAX)));
  } catch {
    // Storage full or unavailable: suggestions just won't include history.
  }
}

/** Commands that extend what's typed: history first (newest first), then snippets. */
export function completions(typed: string, history: string[], snippets: Snippet[], limit = 5): string[] {
  if (typed.trim().length < 2) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  const consider = (cmd: string) => {
    if (out.length >= limit || seen.has(cmd)) return;
    seen.add(cmd);
    if (cmd.length > typed.length && cmd.startsWith(typed) && !cmd.includes("\n")) out.push(cmd);
  };
  for (let i = history.length - 1; i >= 0; i--) consider(history[i]);
  for (const s of snippets) consider(s.command);
  return out;
}
