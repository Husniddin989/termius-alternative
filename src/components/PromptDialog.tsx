import { useState } from "react";

export interface PromptRequest {
  title: string;
  label: string;
  initial?: string;
  confirmLabel?: string;
  resolve: (value: string | null) => void;
}

/** A small one-field dialog (new folder name, rename…). */
export function PromptDialog({ request, onDone }: { request: PromptRequest; onDone: () => void }) {
  const [value, setValue] = useState(request.initial ?? "");
  const finish = (v: string | null) => {
    onDone();
    request.resolve(v);
  };
  return (
    <div className="modal-backdrop" onClick={() => finish(null)}>
      <form
        className="modal"
        onClick={(e) => e.stopPropagation()}
        onSubmit={(e) => {
          e.preventDefault();
          finish(value.trim() || null);
        }}
      >
        <h2>{request.title}</h2>
        <label>
          {request.label}
          <input autoFocus value={value} onChange={(e) => setValue(e.target.value)} onFocus={(e) => e.target.select()} />
        </label>
        <div className="actions">
          <button type="button" className="secondary" onClick={() => finish(null)}>
            Cancel
          </button>
          <button type="submit" className="primary">
            {request.confirmLabel ?? "OK"}
          </button>
        </div>
      </form>
    </div>
  );
}
