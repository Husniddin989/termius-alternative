import type { HostKeyPrompt } from "../api";

interface Props {
  prompt: HostKeyPrompt;
  onAccept: () => void;
  onReject: () => void;
}

export function HostKeyDialog({ prompt, onAccept, onReject }: Props) {
  return (
    <div className="modal-backdrop">
      <div className="modal">
        <h2>Unknown host</h2>
        <p>
          The authenticity of <strong>{prompt.host}:{prompt.port}</strong> can't be established.
          Make sure this fingerprint matches the server before continuing.
        </p>
        <div className="fingerprint">
          <span className="muted">{prompt.algorithm}</span>
          <code>{prompt.fingerprint}</code>
        </div>
        <div className="actions">
          <button className="ghost" onClick={onReject}>
            Reject
          </button>
          <button onClick={onAccept} autoFocus>
            Trust and continue
          </button>
        </div>
      </div>
    </div>
  );
}
