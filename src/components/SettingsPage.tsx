import { useCallback, useEffect, useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import {
  aiApi,
  type AiProvider,
  type LocalModel,
  ollamaApi,
  type PullProgress,
  type Settings,
  settingsApi,
  snippetsApi,
} from "../api";
import { LIBRARY_SNIPPETS } from "../snippetLibrary";
import { AUTO, resolveTheme, type Theme, THEMES } from "../themes";
import { Field } from "./DetailsPanel";
import { DownloadIcon, EyeIcon, EyeOffIcon, KeyIcon, RefreshIcon } from "./icons";

const CLAUDE_MODELS = [
  { id: "claude-opus-5-5", label: "Claude Opus 5.5 (recommended)" },
  { id: "claude-sonnet-5-5", label: "Claude Sonnet 5.5 (cheaper)" },
  { id: "claude-haiku-4-5", label: "Claude Haiku 4.5 (fastest)" },
];

/** Local models that are good at shell commands, smallest first. */
const LOCAL_MODELS = [
  { id: "qwen2.5-coder:1.5b", size: "≈1 GB", note: "Fastest — fine for everyday commands" },
  { id: "qwen2.5-coder:3b", size: "≈2 GB", note: "Recommended balance of speed and quality" },
  { id: "qwen2.5-coder:7b", size: "≈4.7 GB", note: "Best answers; needs 8 GB+ RAM" },
];

const IS_MAC = navigator.platform.toUpperCase().includes("MAC");

function formatBytes(n: number) {
  return n >= 1e9 ? `${(n / 1e9).toFixed(1)} GB` : `${Math.round(n / 1e6)} MB`;
}

interface Props {
  settings: Settings;
  onSettingsChange: (s: Settings) => void;
  onSnippetsChanged: () => void;
}

export function SettingsPage({ settings, onSettingsChange, onSnippetsChanged }: Props) {
  const [note, setNote] = useState<{ text: string; error?: boolean } | null>(null);

  const update = async (patch: Partial<Settings>) => {
    const next = { ...settings, ...patch };
    await settingsApi.set(next);
    onSettingsChange(next);
  };

  const addLibrary = async () => {
    const added = await snippetsApi.seed(LIBRARY_SNIPPETS);
    onSnippetsChanged();
    setNote({ text: added ? `Added ${added} built-in snippets.` : "All built-in snippets are already in your list." });
  };

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>Settings</h1>
        </div>
      </div>
      <div className="page-scroll settings">
        {note && <p className={note.error ? "error" : "notice"}>{note.text}</p>}

        <section className="settings-card">
          <h2>Appearance</h2>
          <div className="theme-grid">
            {[...THEMES.map((t) => t.id), AUTO].map((id) => (
              <button
                key={id}
                className={`theme-card ${settings.theme === id ? "on" : ""}`}
                onClick={() => update({ theme: id })}
              >
                {id === AUTO ? (
                  <span className="theme-preview split">
                    <ThemePreview theme={resolveTheme("daylight")} />
                    <ThemePreview theme={resolveTheme("midnight")} />
                  </span>
                ) : (
                  <span className="theme-preview">
                    <ThemePreview theme={THEMES.find((t) => t.id === id)!} />
                  </span>
                )}
                <span className="theme-name">{id === AUTO ? "Auto (system)" : THEMES.find((t) => t.id === id)!.name}</span>
              </button>
            ))}
          </div>
        </section>

        <section className="settings-card">
          <h2>AI command assistant</h2>
          <p className="muted">
            Press ✦ in a terminal tab ({IS_MAC ? "⌘K" : "Ctrl+Shift+K"}) and describe what you need in any language.
          </p>
          <div className="segmented provider">
            {(
              [
                ["ollama", "Local AI — free, offline"],
                ["anthropic", "Claude API — best quality"],
              ] as [AiProvider, string][]
            ).map(([id, label]) => (
              <button key={id} className={settings.aiProvider === id ? "on" : ""} onClick={() => update({ aiProvider: id })}>
                {label}
              </button>
            ))}
          </div>
          {settings.aiProvider === "ollama" ? (
            <OllamaSettings settings={settings} update={update} />
          ) : (
            <AnthropicSettings settings={settings} update={update} setNote={setNote} />
          )}

          <label className="setting check">
            <input
              type="checkbox"
              checked={settings.aiIncludeOutput}
              onChange={(e) => update({ aiIncludeOutput: e.target.checked })}
            />
            <span>
              Include the last 40 lines of terminal output in AI requests
              <span className="muted small block">
                Helps with “fix this error”.{" "}
                {settings.aiProvider === "ollama"
                  ? "With the local AI nothing leaves your computer."
                  : "Sends what is on screen to the Anthropic API."}
              </span>
            </span>
          </label>
        </section>

        <section className="settings-card">
          <h2>Snippet library</h2>
          <p className="muted">
            {LIBRARY_SNIPPETS.length} ready-made commands for Linux, Docker, Git, systemd, networking, databases and more.
            They also power autocomplete while you type in a terminal (press → to accept a suggestion).
          </p>
          <div>
            <button className="secondary" onClick={addLibrary}>
              Add missing built-in snippets
            </button>
          </div>
        </section>
      </div>
    </div>
  );
}

/** A miniature of the app drawn in the theme's own colours. */
function ThemePreview({ theme }: { theme: Theme }) {
  const v = theme.vars;
  return (
    <span className="mini" style={{ background: v["--bg"], borderColor: v["--border"] }}>
      <span className="mini-side" style={{ background: v["--surface"], borderColor: v["--border"] }}>
        <i style={{ background: v["--accent"] }} />
        <i style={{ background: v["--muted"] }} />
        <i style={{ background: v["--muted"] }} />
      </span>
      <span className="mini-main" style={{ background: v["--surface"] }}>
        <span className="mini-card" style={{ background: v["--surface-2"] }}>
          <b style={{ background: "#e95420" }} />
          <i style={{ background: v["--text"] }} />
        </span>
        <span className="mini-card" style={{ background: v["--surface-2"] }}>
          <b style={{ background: v["--accent"] }} />
          <i style={{ background: v["--text"] }} />
        </span>
        <span className="mini-term" style={{ background: v["--bg"], color: theme.ansi.green }}>
          $ <span style={{ color: v["--accent"] }}>▍</span>
        </span>
      </span>
    </span>
  );
}

type Update = (patch: Partial<Settings>) => Promise<void>;

function OllamaSettings({ settings, update }: { settings: Settings; update: Update }) {
  const [models, setModels] = useState<LocalModel[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [url, setUrl] = useState(settings.ollamaUrl);
  const [pulling, setPulling] = useState<{ model: string; progress: PullProgress | null } | null>(null);
  const [pullError, setPullError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      setModels(await ollamaApi.models(settings.ollamaUrl));
      setError(null);
    } catch (e) {
      setModels(null);
      setError(String(e));
    }
  }, [settings.ollamaUrl]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const installed = new Set(models?.map((m) => m.name) ?? []);
  const selectedInstalled = installed.has(settings.ollamaModel);

  const download = async (model: string) => {
    setPulling({ model, progress: null });
    setPullError(null);
    try {
      await ollamaApi.pull(settings.ollamaUrl, model, (progress) => setPulling({ model, progress }));
      await refresh();
      if (!selectedInstalled) await update({ ollamaModel: model });
    } catch (e) {
      setPullError(String(e));
    } finally {
      setPulling(null);
    }
  };

  return (
    <>
      <p className="muted">
        Runs an open model on this computer with{" "}
        <button className="link" onClick={() => openUrl("https://ollama.com/download")}>
          Ollama
        </button>
        . Free, private and works offline — answers take a few seconds longer than the cloud.
      </p>

      {error ? (
        <div className="setup-box">
          <strong>Ollama is not running</strong>
          <ol>
            <li>
              Download and install it from{" "}
              <button className="link" onClick={() => openUrl("https://ollama.com/download")}>
                ollama.com/download
              </button>
              {IS_MAC && (
                <>
                  {" "}
                  (or run <code>brew install ollama</code>)
                </>
              )}
              .
            </li>
            <li>Open the Ollama app (or run <code>ollama serve</code>).</li>
            <li>Come back here and press Check again, then download a model below.</li>
          </ol>
          <div>
            <button className="secondary" onClick={refresh}>
              <RefreshIcon size={15} /> Check again
            </button>
          </div>
        </div>
      ) : (
        <p className={selectedInstalled ? "notice" : "muted small"}>
          {models === null
            ? "Checking Ollama…"
            : selectedInstalled
              ? `Ready: using ${settings.ollamaModel}.`
              : `Ollama is running. Download a model below to start.`}
        </p>
      )}

      <div className="model-list">
        {LOCAL_MODELS.map((m) => {
          const isInstalled = installed.has(m.id);
          const isSelected = settings.ollamaModel === m.id;
          const isPulling = pulling?.model === m.id;
          const p = isPulling ? pulling?.progress : null;
          return (
            <div key={m.id} className={`model-row ${isSelected ? "selected" : ""}`}>
              <label className="model-pick">
                <input
                  type="radio"
                  name="ollama-model"
                  checked={isSelected}
                  disabled={!isInstalled}
                  onChange={() => update({ ollamaModel: m.id })}
                />
                <span>
                  <strong>{m.id}</strong> <span className="muted small">{m.size}</span>
                  <span className="muted small block">{m.note}</span>
                </span>
              </label>
              {isInstalled ? (
                <span className="muted small">Installed</span>
              ) : isPulling ? (
                <span className="pull-progress">
                  <progress value={p?.completed ?? 0} max={p?.total || 1} />
                  <span className="muted small">
                    {p?.total ? `${formatBytes(p.completed)} / ${formatBytes(p.total)}` : (p?.status ?? "Starting…")}
                  </span>
                </span>
              ) : (
                <button className="secondary" disabled={!!error || !!pulling} onClick={() => download(m.id)}>
                  <DownloadIcon size={15} /> Download
                </button>
              )}
            </div>
          );
        })}
        {models
          ?.filter((m) => !LOCAL_MODELS.some((l) => l.id === m.name))
          .map((m) => (
            <div key={m.name} className={`model-row ${settings.ollamaModel === m.name ? "selected" : ""}`}>
              <label className="model-pick">
                <input
                  type="radio"
                  name="ollama-model"
                  checked={settings.ollamaModel === m.name}
                  onChange={() => update({ ollamaModel: m.name })}
                />
                <span>
                  <strong>{m.name}</strong> <span className="muted small">{formatBytes(m.size)}</span>
                </span>
              </label>
              <span className="muted small">Installed</span>
            </div>
          ))}
      </div>
      {pullError && <p className="error small">{pullError}</p>}

      <label className="setting">
        <span>Ollama address</span>
        <div className="setting-row">
          <Field value={url} onChange={(e) => setUrl(e.target.value)} />
          <button className="secondary" disabled={url === settings.ollamaUrl} onClick={() => update({ ollamaUrl: url.trim() })}>
            Save
          </button>
        </div>
      </label>
    </>
  );
}

function AnthropicSettings({
  settings,
  update,
  setNote,
}: {
  settings: Settings;
  update: Update;
  setNote: (n: { text: string; error?: boolean }) => void;
}) {
  const [hasKey, setHasKey] = useState(false);
  const [key, setKey] = useState("");
  const [showKey, setShowKey] = useState(false);

  useEffect(() => {
    aiApi.hasKey().then(setHasKey, () => setHasKey(false));
  }, []);

  const saveKey = async (value: string) => {
    try {
      await aiApi.setKey(value);
      setHasKey(!!value.trim());
      setKey("");
      setNote({ text: value.trim() ? "API key saved in the system keychain." : "API key removed." });
    } catch (e) {
      setNote({ text: String(e), error: true });
    }
  };

  return (
    <>
      <p className="muted">Requests go from this app directly to the Anthropic API, billed to your own account.</p>
      <label className="setting">
        <span>Anthropic API key</span>
        <div className="setting-row">
          <Field
            icon={<KeyIcon size={15} />}
            type={showKey ? "text" : "password"}
            placeholder={hasKey ? "•••••• saved in keychain" : "sk-ant-…"}
            value={key}
            onChange={(e) => setKey(e.target.value)}
            trailing={
              <button type="button" className="icon-btn" onClick={() => setShowKey((s) => !s)} title="Show">
                {showKey ? <EyeOffIcon size={15} /> : <EyeIcon size={15} />}
              </button>
            }
          />
          <button className="primary" disabled={!key.trim()} onClick={() => saveKey(key)}>
            Save
          </button>
          {hasKey && (
            <button className="secondary" onClick={() => saveKey("")}>
              Remove
            </button>
          )}
        </div>
        <span className="muted small">Create one at console.anthropic.com → API Keys.</span>
      </label>
      <label className="setting">
        <span>Model</span>
        <select value={settings.aiModel} onChange={(e) => update({ aiModel: e.target.value })}>
          {CLAUDE_MODELS.map((m) => (
            <option key={m.id} value={m.id}>
              {m.label}
            </option>
          ))}
        </select>
      </label>
    </>
  );
}
