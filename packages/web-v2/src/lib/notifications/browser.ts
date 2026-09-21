
const OPT_IN_KEY = "forge:browser-notify";

export type BrowserPermission = NotificationPermission | "unsupported";

export function isSupported(): boolean {
  return typeof window !== "undefined" && "Notification" in window;
}

/** Live browser permission state, or `"unsupported"` when the API is absent. */
export function getPermission(): BrowserPermission {
  if (!isSupported()) return "unsupported";
  return Notification.permission;
}

/** Whether the user has opted in via Settings (localStorage flag). */
export function isEnabled(): boolean {
  if (typeof window === "undefined") return false;
  return window.localStorage.getItem(OPT_IN_KEY) === "1";
}

export function setEnabled(on: boolean): void {
  if (typeof window === "undefined") return;
  if (on) window.localStorage.setItem(OPT_IN_KEY, "1");
  else window.localStorage.removeItem(OPT_IN_KEY);
}

/**
 * Request browser permission. MUST be called from a user gesture. Returns the
 * resulting permission (or `"unsupported"`); never throws.
 */
export async function requestPermission(): Promise<BrowserPermission> {
  if (!isSupported()) return "unsupported";
  try {
    return await Notification.requestPermission();
  } catch {
    return Notification.permission;
  }
}

export interface FireBrowserNotificationOptions {
  title: string;
  body?: string;
  /** Coalesces repeat notifications about the same entity (notificationId). */
  tag?: string;
  onClick?: () => void;
}

export function fireBrowserNotification(opts: FireBrowserNotificationOptions): void {
  if (!isSupported() || Notification.permission !== "granted" || !isEnabled()) return;
  if (typeof document !== "undefined" && document.visibilityState === "visible") return;
  try {
    const n = new Notification(opts.title, { body: opts.body, tag: opts.tag });
    n.onclick = () => {
      try {
        window.focus();
      } catch {
        // focus can throw in some embedded contexts — ignore.
      }
      opts.onClick?.();
      n.close();
    };
  } catch {
    // Notification construction can throw on some platforms — degrade silently.
  }
}

export function showTestNotification(): void {
  if (!isSupported() || Notification.permission !== "granted" || !isEnabled()) return;
  try {
    const n = new Notification("Desktop notifications enabled", {
      body: "You'll get a notification here for high-signal events when this tab is in the background.",
      tag: "forge:notify-test",
    });
    n.onclick = () => {
      try {
        window.focus();
      } catch {
      }
      n.close();
    };
  } catch {
  }
}
