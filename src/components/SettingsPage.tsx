import { useEffect, useState } from "react";
import { aiApi, type Settings, settingsApi, snippetsApi } from "../api";
import { LIBRARY_SNIPPETS } from "../snippetLibrary";
import { Field } from "./DetailsPanel";
import { EyeIcon, EyeOffIcon, KeyIcon } from "./icons";

const MODELS = [
  { id: "claude-opus-5-5", label: "Claude Opus 5.5 (recommended)" },
  { id: "claude-sonnet-5-5", label: "Claude Sonnet 5.5 (cheaper)" },
  { id: "claude-haiku-4-5", label: "Claude Haiku 4.5 (fastest)" },
];

interface Props {
  settings: Settings;
  onSettingsChange: (s: Settings) => void;
  onSnippetsChanged: () => void;
}

export function SettingsPage({ settings, onSettingsChange, onSnippetsChanged }: Props) {
  const [hasKey, setHasKey] = useState(false);
  const [key, setKey] = useState("");
  const [showKey, setShowKey] = useState(false);
  const [note, setNote] = useState<{ text: string; error?: boolean } | null>(null);

  useEffect(() => {
    aiApi.hasKey().then(setHasKey, () => setHasKey(false));
  }, []);

  const update = async (patch: Partial<Settings>) => {
    const next = { ...settings, ...patch };
    await settingsApi.set(next);
    onSettingsChange(next);
  };

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
          <h2>AI command assistant</h2>
          <p className="muted">
            Press the ✦ button in a terminal tab (or ⌘K / Ctrl+Shift+K) and describe what you want — in any language.
            Requests go from this app directly to the Anthropic API using your own API key.
          </p>

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
            <span className="muted small">Create one at console.anthropic.com → API Keys. Usage is billed to your Anthropic account.</span>
          </label>

          <label className="setting">
            <span>Model</span>
            <select value={settings.aiModel} onChange={(e) => update({ aiModel: e.target.value })}>
              {MODELS.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.label}
                </option>
              ))}
            </select>
          </label>

          <label className="setting check">
            <input
              type="checkbox"
              checked={settings.aiIncludeOutput}
              onChange={(e) => update({ aiIncludeOutput: e.target.checked })}
            />
            <span>
              Include the last 40 lines of terminal output in AI requests
              <span className="muted small block">
                Gives better answers for “fix this error”, but sends what is on screen to the API.
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
