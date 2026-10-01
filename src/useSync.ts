import { useCallback, useEffect, useRef, useState } from "react";
import { LOCAL_CHANGE_EVENT, syncApi, type SyncReport, type SyncStatus } from "./api";

/** Pull other devices' changes this often while the app is open. */
const INTERVAL_MS = 3 * 60_000;
/** Wait this long after a local edit, so a burst of edits is one upload. */
const DEBOUNCE_MS = 4_000;
/** Coming back to the app syncs, but not more often than this. */
const FOCUS_GAP_MS = 30_000;

export interface SyncControl {
  status: SyncStatus | null;
  syncing: boolean;
  /** Runs a round now; resolves to an error message, or null on success. */
  syncNow: () => Promise<string | null>;
  /** Connects this device to the vault and runs the first round. */
  setup: (token: string, passphrase: string) => Promise<SyncReport>;
  disable: () => Promise<void>;
}

/**
 * Keeps this device in step with the encrypted vault: on start, every few
 * minutes, when the window regains focus and shortly after local edits.
 * `onRemoteChange` runs when another device's changes were applied here.
 */
export function useSync(onRemoteChange: () => void): SyncControl {
  const [status, setStatus] = useState<SyncStatus | null>(null);
  const [syncing, setSyncing] = useState(false);
  const running = useRef<Promise<string | null> | null>(null);
  const again = useRef(false);
  const lastRun = useRef(0);
  const onChange = useRef(onRemoteChange);
  onChange.current = onRemoteChange;

  const refresh = useCallback(async () => {
    setStatus(await syncApi.status().catch(() => null));
  }, []);

  const syncNow = useCallback((): Promise<string | null> => {
    // An edit made during a round needs one more round afterwards.
    if (running.current) {
      again.current = true;
      return running.current;
    }
    const round = (async () => {
      setSyncing(true);
      let error: string | null = null;
      try {
        do {
          again.current = false;
          lastRun.current = Date.now();
          const report = await syncApi.now();
          if (report?.changed) onChange.current();
        } while (again.current);
      } catch (e) {
        error = String(e);
      } finally {
        running.current = null;
        setSyncing(false);
        await refresh();
      }
      return error;
    })();
    running.current = round;
    return round;
  }, [refresh]);

  const setup = useCallback(
    async (token: string, passphrase: string) => {
      const report = await syncApi.setup(token, passphrase);
      lastRun.current = Date.now();
      if (report.changed) onChange.current();
      await refresh();
      return report;
    },
    [refresh],
  );

  const disable = useCallback(async () => {
    await syncApi.disable();
    await refresh();
  }, [refresh]);

  const enabled = !!status?.enabled;

  useEffect(() => {
    refresh();
  }, [refresh]);

  useEffect(() => {
    if (!enabled) return;
    if (Date.now() - lastRun.current > FOCUS_GAP_MS) syncNow(); // setup has just synced
    let timer: number | undefined;
    const onLocal = () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(syncNow, DEBOUNCE_MS);
    };
    const onFocus = () => {
      if (document.visibilityState === "visible" && Date.now() - lastRun.current > FOCUS_GAP_MS) syncNow();
    };
    const interval = window.setInterval(syncNow, INTERVAL_MS);
    window.addEventListener(LOCAL_CHANGE_EVENT, onLocal);
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onFocus);
    return () => {
      window.clearTimeout(timer);
      window.clearInterval(interval);
      window.removeEventListener(LOCAL_CHANGE_EVENT, onLocal);
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onFocus);
    };
  }, [enabled, syncNow]);

  return { status, syncing, syncNow, setup, disable };
}
