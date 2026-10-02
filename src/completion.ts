import { COMMAND_NAMES, SPECS, type Spec } from "./commandSpecs";

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

export type SuggestionKind = "history" | "command" | "subcommand" | "option" | "dir" | "file";

export interface Suggestion {
  /** Text appended to the line when accepted. */
  insert: string;
  label: string;
  detail?: string;
  kind: SuggestionKind;
}

export interface CompletionContext {
  /** Shell history, newest last. */
  history: string[];
  /** The shell's working directory ("~", an absolute path) or null if unknown. */
  cwd: string | null;
  /** Cached entries of a directory (dirs end with "/"), or undefined if not loaded yet. */
  listing: (dir: string) => string[] | undefined;
}

export interface CompletionResult {
  items: Suggestion[];
  /** A directory whose listing would add suggestions. */
  need: string | null;
}

const LIMIT = 8;
/** Words that run the command after them. */
const PREFIXES = new Set(["sudo", "time", "nohup", "nice", "exec", "command"]);

/** Joins and normalises a path; keeps a leading "~". Null when ".." leaves "~" (home's parent is unknown). */
export function joinPath(base: string, rel: string): string | null {
  const abs = rel.startsWith("/") || rel === "~" || rel.startsWith("~/");
  const start = abs ? rel : `${base.replace(/\/$/, "")}/${rel}`;
  const home = start === "~" || start.startsWith("~/");
  const parts: string[] = [];
  for (const part of (home ? start.slice(1) : start).split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") {
      if (home && parts.length === 0) return null;
      parts.pop();
    } else parts.push(part);
  }
  if (home) return parts.length ? `~/${parts.join("/")}` : "~";
  return `/${parts.join("/")}`;
}

/** Updates the tracked working directory after a command ran. */
export function cwdAfter(cwd: string | null, command: string): string | null {
  const m = /^cd(?:\s+(\S+))?\s*$/.exec(command.trim());
  if (!m) return cwd;
  const arg = m[1];
  if (!arg || arg === "~") return "~";
  if (arg === "-") return null;
  if (arg.startsWith("/") || arg.startsWith("~/")) return joinPath("/", arg);
  return cwd ? joinPath(cwd, arg) : null;
}

/** Working directory shown by common prompts: `user@host:~/dir$ `, `[user@host ~]# `. */
export function cwdFromPrompt(prompt: string): string | null {
  const m = /:\s*(~[^\s$#%>]*|\/[^\s$#%>]*)\s*[$#%>]\s*$/.exec(prompt);
  if (m) return m[1];
  if (/^\[[^\]]*\s~\]\s*[$#]\s*$/.test(prompt.trim())) return "~";
  return null;
}

const escapeWord = (w: string) => w.replace(/([\s'"\\$`!&|;()<>*?])/g, "\\$1");

function pathSuggestions(token: string, ctx: CompletionContext, dirsOnly: boolean): CompletionResult {
  const slash = token.lastIndexOf("/");
  const typedDir = slash >= 0 ? token.slice(0, slash + 1) : "";
  const base = slash >= 0 ? token.slice(slash + 1) : token;
  let dir: string | null;
  if (typedDir.startsWith("/") || typedDir.startsWith("~/")) dir = joinPath("/", typedDir);
  else if (token === "~") return { items: [{ insert: "/", label: "~/", kind: "dir" }], need: null };
  else dir = ctx.cwd ? joinPath(ctx.cwd, typedDir || ".") : null;
  if (!dir) return { items: [], need: null };

  const entries = ctx.listing(dir);
  if (!entries) return { items: [], need: dir };
  const items = entries
    .filter((e) => e.startsWith(base) && e !== base)
    .filter((e) => base.startsWith(".") || !e.startsWith("."))
    .filter((e) => !dirsOnly || e.endsWith("/"))
    .map<Suggestion>((e) => ({
      insert: escapeWord(e.slice(base.length).replace(/\/$/, "")) + (e.endsWith("/") ? "/" : " "),
      label: e,
      kind: e.endsWith("/") ? "dir" : "file",
    }));
  return { items, need: null };
}

/**
 * Suggestions for the line being typed: matching history lines, then the
 * command / subcommand / option / path that completes the current word.
 */
export function suggest(line: string, ctx: CompletionContext): CompletionResult {
  if (!line.trim()) return { items: [], need: null };
  const items: Suggestion[] = [];
  let need: string | null = null;
  const seen = new Set<string>();
  const add = (s: Suggestion) => {
    if (!s.insert || seen.has(s.insert) || items.length >= LIMIT) return;
    seen.add(s.insert);
    items.push(s);
  };

  // Whole lines from history, newest first.
  if (line.trim().length >= 2) {
    let n = 0;
    for (let i = ctx.history.length - 1; i >= 0 && n < 3; i--) {
      const h = ctx.history[i];
      if (h.length > line.length && h.startsWith(line) && !h.includes("\n")) {
        add({ insert: h.slice(line.length), label: h, kind: "history" });
        n++;
      }
    }
  }

  // The command after the last pipe / && / ;
  const segment = line.split(/\|\||&&|[|;]/).pop()!.replace(/^\s+/, "");
  const words = segment.split(/\s+/);
  const current = words.pop() ?? "";
  let prev = words.filter(Boolean);
  while (prev.length && PREFIXES.has(prev[0])) {
    prev = prev.slice(1);
    while (prev.length && prev[0].startsWith("-")) prev = prev.slice(1);
  }

  if (prev.length === 0) {
    if (current.length >= 1 && !current.includes("/")) {
      for (const name of COMMAND_NAMES)
        if (name.startsWith(current) && name !== current)
          add({ insert: name.slice(current.length) + " ", label: name, detail: SPECS[name].d, kind: "command" });
    } else if (current.includes("/") || current.startsWith(".")) {
      const r = pathSuggestions(current, ctx, false);
      r.items.forEach(add);
      need = r.need;
    }
    return { items, need };
  }

  let spec: Spec | undefined = SPECS[prev[0]];
  for (const w of prev.slice(1)) {
    if (w.startsWith("-") || !spec?.sub?.[w]) continue;
    spec = spec.sub[w];
  }

  if (current.startsWith("-")) {
    for (const [opt, d] of spec?.opts ?? [])
      if (opt.startsWith(current) && opt !== current) add({ insert: opt.slice(current.length) + " ", label: opt, detail: d, kind: "option" });
    return { items, need };
  }

  for (const [name, sub] of Object.entries(spec?.sub ?? {}))
    if (name.startsWith(current) && name !== current)
      add({ insert: name.slice(current.length) + " ", label: name, detail: sub.d, kind: "subcommand" });

  const looksLikePath = current.includes("/") || current.startsWith(".") || current.startsWith("~");
  if (spec?.paths || looksLikePath) {
    const r = pathSuggestions(current, ctx, spec?.paths === "dirs");
    r.items.forEach(add);
    need = r.need;
  }

  // Options that read like words ("aux", "755", "now") also complete plain words;
  // after a bare space, list the dashed ones too.
  for (const [opt, d] of spec?.opts ?? [])
    if (opt.startsWith(current) && opt !== current && (current !== "" || items.length < 4))
      add({ insert: opt.slice(current.length) + " ", label: opt, detail: d, kind: "option" });

  return { items, need };
}
