import { useCallback, useEffect, useRef, useState } from "react";
import type { Update, DownloadEvent } from "@tauri-apps/plugin-updater";

const isTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000; // 6 hours
const RETRY_DELAY_MS = 30_000; // 30s retry on network error

interface UpdaterState {
  updateAvailable: boolean;
  checking: boolean;
  downloading: boolean;
  progress: number;
  error: string | null;
  readyToRestart: boolean;
  version: string | null;
  releaseNotes: string | null;
}

export function useAutoUpdater() {
  const [state, setState] = useState<UpdaterState>({
    updateAvailable: false,
    checking: false,
    downloading: false,
    progress: 0,
    error: null,
    readyToRestart: false,
    version: null,
    releaseNotes: null,
  });
  const retryTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const updateRef = useRef<Update | null>(null);

  const checkForUpdate = useCallback(async (isRetry = false) => {
    if (!isTauri) return;
    // Skip auto-updater in dev (tauri dev) — the GitHub Releases endpoint
    // returns 404 for unreleased versions and the resulting banner is noise.
    // Production builds (tauri build) always run with import.meta.env.DEV=false.
    if (import.meta.env.DEV) return;
    setState((s) => ({ ...s, checking: true, error: null }));
    try {
      const { check } = await import("@tauri-apps/plugin-updater");
      const update = await check();
      updateRef.current = update;
      setState((s) => ({
        ...s,
        checking: false,
        updateAvailable: update !== null,
        version: update?.version ?? null,
        releaseNotes: update?.body ?? null,
      }));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setState((s) => ({
        ...s,
        checking: false,
        error: `Update check failed: ${msg}`,
      }));
      if (!isRetry) {
        retryTimer.current = setTimeout(() => checkForUpdate(true), RETRY_DELAY_MS);
      }
    }
  }, []);

  const installUpdate = useCallback(async () => {
    const update = updateRef.current;
    if (!isTauri || !update) return;
    setState((s) => ({ ...s, downloading: true, progress: 0, error: null }));
    try {
      let contentLength = 0;
      let downloaded = 0;
      await update.downloadAndInstall((event: DownloadEvent) => {
        if (event.event === "Started") {
          contentLength = event.data.contentLength ?? 0;
          downloaded = 0;
        } else if (event.event === "Progress") {
          downloaded += event.data.chunkLength;
          if (contentLength > 0) {
            setState((s) => ({
              ...s,
              progress: Math.min(99, Math.round((downloaded / contentLength) * 100)),
            }));
          }
        } else if (event.event === "Finished") {
          setState((s) => ({ ...s, progress: 100 }));
        }
      });
      setState((s) => ({
        ...s,
        downloading: false,
        readyToRestart: true,
        progress: 100,
      }));
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Update download failed";
      setState((s) => ({
        ...s,
        downloading: false,
        error: msg,
      }));
    }
  }, []);

  const restartApp = useCallback(async () => {
    if (!isTauri) return;
    try {
      const { relaunch } = await import("@tauri-apps/plugin-process");
      await relaunch();
    } catch {
      window.close();
    }
  }, []);

  const dismissError = useCallback(() => {
    setState((s) => ({ ...s, error: null }));
  }, []);

  useEffect(() => {
    checkForUpdate();
    const interval = setInterval(() => checkForUpdate(), CHECK_INTERVAL_MS);
    return () => {
      clearInterval(interval);
      if (retryTimer.current) clearTimeout(retryTimer.current);
    };
  }, [checkForUpdate]);

  return {
    ...state,
    checkForUpdate: () => checkForUpdate(),
    installUpdate,
    restartApp,
    dismissError,
  };
}
