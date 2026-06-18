// Web Notification API wrapper (ISS-510) — the browser/OS delivery channel.
//
// Two independent gates must BOTH be true before a native notification fires:
//   1. `Notification.permission === 'granted'` — the browser-level grant.
//   2. `isEnabled()` — the user's explicit in-app opt-in (localStorage), set
//      from the Settings toggle. The opt-in is intentionally separate from the
//      permission so a user who granted permission once can still mute the
//      feature without revoking it at the OS level.
//
// Permission is only ever requested from an explicit user gesture (the Settings
// toggle) — never auto-prompted on load. Everything degrades to no-op when the
// API is unsupported or denied, so callers never need to guard.

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

/**
 * Fire a native OS notification — but only when permitted, opted-in, AND the
 * tab is not currently focused (a focused tab gets the in-app toast instead, so
 * the two channels never double-fire). Clicking focuses the window and runs
 * `onClick` (deep-link). No-op + swallow on any failure.
 */
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
