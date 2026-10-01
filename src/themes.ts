import type { ITheme } from "@xterm/xterm";

/**
 * Colour themes. Each sets the CSS variables used throughout App.css and
 * the terminal palette, so the UI and the shell always match.
 */
export interface Theme {
  id: string;
  name: string;
  dark: boolean;
  vars: Record<string, string>;
  /** ANSI colours etc.; background/foreground/cursor are derived from vars. */
  ansi: Omit<ITheme, "background" | "foreground" | "cursor" | "cursorAccent" | "selectionBackground">;
}

const darkStatus = {
  "--danger": "#f87171",
  "--ok": "#4ade80",
  "--warn": "#fbbf24",
  "--warn-soft": "rgba(251, 191, 36, 0.1)",
  "--ok-soft": "rgba(74, 222, 128, 0.13)",
  "--violet": "#c4b5fd",
  "--violet-soft": "rgba(167, 139, 250, 0.14)",
  "--backdrop": "rgba(5, 7, 10, 0.6)",
  "--shadow": "rgba(0, 0, 0, 0.45)",
  "--card-border": "transparent",
};

const darkAnsi: Theme["ansi"] = {
  black: "#1c2028",
  red: "#f87171",
  green: "#4ade80",
  yellow: "#fbbf24",
  blue: "#60a5fa",
  magenta: "#c084fc",
  cyan: "#22d3ee",
  white: "#d6dae2",
  brightBlack: "#4b5263",
  brightRed: "#fca5a5",
  brightGreen: "#86efac",
  brightYellow: "#fde68a",
  brightBlue: "#93c5fd",
  brightMagenta: "#d8b4fe",
  brightCyan: "#67e8f9",
  brightWhite: "#f8fafc",
};

export const THEMES: Theme[] = [
  {
    id: "midnight",
    name: "Midnight",
    dark: true,
    vars: {
      "--bg": "#0f1115",
      "--surface": "#14171d",
      "--surface-2": "#1a1e25",
      "--surface-3": "#232831",
      "--surface-4": "#2f3540",
      "--input": "#101318",
      "--border": "#262b35",
      "--border-strong": "#333a46",
      "--text": "#e4e7ec",
      "--muted": "#8a92a2",
      "--placeholder": "#5f6777",
      "--accent": "#2dd4bf",
      "--accent-strong": "#14b8a6",
      "--accent-ink": "#032420",
      "--accent-soft": "rgba(45, 212, 191, 0.13)",
      ...darkStatus,
    },
    ansi: darkAnsi,
  },
  {
    id: "ocean",
    name: "Ocean",
    dark: true,
    vars: {
      "--bg": "#0b1220",
      "--surface": "#0f172a",
      "--surface-2": "#15203a",
      "--surface-3": "#1d2a48",
      "--surface-4": "#273657",
      "--input": "#0a1120",
      "--border": "#1f2b45",
      "--border-strong": "#2b3a5c",
      "--text": "#e2e8f0",
      "--muted": "#8b9bb8",
      "--placeholder": "#5b6b88",
      "--accent": "#60a5fa",
      "--accent-strong": "#3b82f6",
      "--accent-ink": "#06152e",
      "--accent-soft": "rgba(96, 165, 250, 0.15)",
      ...darkStatus,
    },
    ansi: { ...darkAnsi, black: "#16203a", brightBlack: "#46557a", blue: "#7cb5ff", cyan: "#38bdf8" },
  },
  {
    id: "amethyst",
    name: "Amethyst",
    dark: true,
    vars: {
      "--bg": "#13111c",
      "--surface": "#18151f",
      "--surface-2": "#1f1b2b",
      "--surface-3": "#2a2440",
      "--surface-4": "#342d4d",
      "--input": "#110f19",
      "--border": "#2a2438",
      "--border-strong": "#3a3250",
      "--text": "#ece8f6",
      "--muted": "#9a91b3",
      "--placeholder": "#675f80",
      "--accent": "#a78bfa",
      "--accent-strong": "#8b5cf6",
      "--accent-ink": "#170c33",
      "--accent-soft": "rgba(167, 139, 250, 0.16)",
      ...darkStatus,
      "--violet": "#f0abfc",
      "--violet-soft": "rgba(240, 171, 252, 0.13)",
    },
    ansi: { ...darkAnsi, black: "#211c30", brightBlack: "#564c72", magenta: "#e879f9", blue: "#a5b4fc" },
  },
  {
    id: "forest",
    name: "Forest",
    dark: true,
    vars: {
      "--bg": "#0d130f",
      "--surface": "#111a14",
      "--surface-2": "#16211a",
      "--surface-3": "#1e2c23",
      "--surface-4": "#28392e",
      "--input": "#0b110d",
      "--border": "#1f2c24",
      "--border-strong": "#2c3d32",
      "--text": "#e3ece5",
      "--muted": "#8ea597",
      "--placeholder": "#5c7064",
      "--accent": "#4ade80",
      "--accent-strong": "#22c55e",
      "--accent-ink": "#052e16",
      "--accent-soft": "rgba(74, 222, 128, 0.14)",
      ...darkStatus,
    },
    ansi: { ...darkAnsi, black: "#17221b", brightBlack: "#4a5e51", green: "#86efac", brightGreen: "#bbf7d0" },
  },
  {
    id: "ember",
    name: "Ember",
    dark: true,
    vars: {
      "--bg": "#15100d",
      "--surface": "#1b1511",
      "--surface-2": "#231b16",
      "--surface-3": "#2e241d",
      "--surface-4": "#3a2e25",
      "--input": "#120d0a",
      "--border": "#2d231c",
      "--border-strong": "#3d3027",
      "--text": "#f3ebe4",
      "--muted": "#ab9a8c",
      "--placeholder": "#77675a",
      "--accent": "#fb923c",
      "--accent-strong": "#f97316",
      "--accent-ink": "#2b1203",
      "--accent-soft": "rgba(251, 146, 60, 0.15)",
      ...darkStatus,
    },
    ansi: { ...darkAnsi, black: "#241c17", brightBlack: "#5e4d41", yellow: "#fdba74", brightYellow: "#fed7aa" },
  },
  {
    id: "daylight",
    name: "Daylight",
    dark: false,
    vars: {
      "--bg": "#f3f5f8",
      "--surface": "#f8f9fb",
      "--surface-2": "#ffffff",
      "--surface-3": "#e9edf2",
      "--surface-4": "#dde3ea",
      "--input": "#ffffff",
      "--border": "#dde2e8",
      "--border-strong": "#c9d0d9",
      "--text": "#1c2330",
      "--muted": "#5d6878",
      "--placeholder": "#9aa4b2",
      "--accent": "#0d9488",
      "--accent-strong": "#0f766e",
      "--accent-ink": "#ffffff",
      "--accent-soft": "rgba(13, 148, 136, 0.12)",
      "--danger": "#dc2626",
      "--ok": "#16a34a",
      "--warn": "#b45309",
      "--warn-soft": "rgba(217, 119, 6, 0.1)",
      "--ok-soft": "rgba(22, 163, 74, 0.12)",
      "--violet": "#7c3aed",
      "--violet-soft": "rgba(124, 58, 237, 0.1)",
      "--backdrop": "rgba(15, 23, 42, 0.35)",
      "--shadow": "rgba(15, 23, 42, 0.15)",
      "--card-border": "#e3e7ec",
    },
    ansi: {
      black: "#1f2937",
      red: "#dc2626",
      green: "#16a34a",
      yellow: "#b45309",
      blue: "#2563eb",
      magenta: "#9333ea",
      cyan: "#0891b2",
      white: "#6b7280",
      brightBlack: "#4b5563",
      brightRed: "#ef4444",
      brightGreen: "#22c55e",
      brightYellow: "#d97706",
      brightBlue: "#3b82f6",
      brightMagenta: "#a855f7",
      brightCyan: "#06b6d4",
      brightWhite: "#9ca3af",
    },
  },
];

/** "auto" follows the operating system's light/dark preference. */
export const AUTO = "auto";
const STORAGE_KEY = "theme";

const prefersDark = () => window.matchMedia?.("(prefers-color-scheme: dark)").matches ?? true;

export function resolveTheme(id: string): Theme {
  if (id === AUTO) return THEMES.find((t) => t.id === (prefersDark() ? "midnight" : "daylight"))!;
  return THEMES.find((t) => t.id === id) ?? THEMES[0];
}

export function terminalTheme(theme: Theme): ITheme {
  const v = theme.vars;
  return {
    ...theme.ansi,
    background: v["--bg"],
    foreground: theme.dark ? "#d6dae2" : "#1f2937",
    cursor: v["--accent"],
    cursorAccent: v["--bg"],
    selectionBackground: v["--accent-soft"].replace(/[\d.]+\)$/, "0.35)"),
  };
}

/** Applies a theme to the page and remembers it for the next start (avoids a flash). */
export function applyTheme(id: string): Theme {
  const theme = resolveTheme(id);
  const root = document.documentElement;
  for (const [name, value] of Object.entries(theme.vars)) root.style.setProperty(name, value);
  root.style.colorScheme = theme.dark ? "dark" : "light";
  try {
    localStorage.setItem(STORAGE_KEY, id);
  } catch {
    // Not persisted; the saved setting is applied once it loads.
  }
  return theme;
}

/** The theme chosen last time, applied before the first paint. */
export function storedThemeId(): string {
  try {
    return localStorage.getItem(STORAGE_KEY) ?? "midnight";
  } catch {
    return "midnight";
  }
}
