import { useCallback } from "react";

const isTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

interface NotifyOptions {
  title: string;
  body: string;
}

export function useNotifications() {
  const notify = useCallback(async ({ title, body }: NotifyOptions) => {
    if (isTauri) {
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
  }, []);

  return { notify };
}
