import { useCallback } from "react";

// Evaluated per-call (not at module load) so unit tests can flip
// __TAURI_INTERNALS__ between cases without reloading the module.
function inTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

interface NotifyOptions {
  title: string;
  body: string;
}

/**
 * Pure async notify function. Extracted from `useNotifications` so unit
 * tests can exercise the Tauri-vs-browser branches without renderHook (the
 * dev-package test harness can't reliably mount hooks across the workspace's
 * React 18/19 split — see `vitest.config.ts`).
 */
export async function notify({ title, body }: NotifyOptions): Promise<void> {
  if (inTauri()) {
    try {
      const { sendNotification, isPermissionGranted, requestPermission } =
        await import("@tauri-apps/plugin-notification");
      let allowed = await isPermissionGranted();
      if (!allowed) {
        const perm = await requestPermission();
        allowed = perm === "granted";
      }
      if (allowed) {
        sendNotification({ title, body });
      }
    } catch {
      // Plugin not available
    }
  } else if ("Notification" in window) {
    if (Notification.permission === "granted") {
      new Notification(title, { body });
    } else if (Notification.permission !== "denied") {
      const perm = await Notification.requestPermission();
      if (perm === "granted") new Notification(title, { body });
    }
  }
}

export function useNotifications() {
  const memoized = useCallback(notify, []);
  return { notify: memoized };
}
