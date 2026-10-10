// The auth redirect to /login happens at most once per navigation (REQ-39 BC-4 seen in a frame, the
// owner's "the preview page loops on login", 2026-10-10). A page with no session sends the browser to
// /login; a /login that sends it straight back, because the session cannot be kept (cookies blocked in
// this frame) or was refused, would go round for ever. So the first bounce is recorded for the tab,
// and a second one inside the window is not made: the page stops and names the cause instead.

/** A bounce this recent is "the previous navigation"; a person who comes back later is not looping. */
export const BOUNCE_WINDOW_MS = 30_000;

import { assetPath } from "@/lib/asset";

const KEY = "forge.loginBounce";
const NAME_PREFIX = "forge.loginBounce:";

type BounceCause = "frame-cookies" | "sign-in-refused";

/** Whether this page is shown inside another page, whose site may be a different one. */
function isFramed(): boolean {
  try {
    return window.self !== window.top;
  } catch {
    return true;
  }
}

/** The cause a stopped page names: a frame that keeps no cookie is the usual one, a refusal the rest. */
export function bounceCause(): BounceCause {
  return isFramed() ? "frame-cookies" : "sign-in-refused";
}

function read(): number | null {
  try {
    const raw = window.sessionStorage.getItem(KEY);
    return raw === null ? null : Number(raw);
  } catch {
    // storage refused (a frame with blocked site data): the tab's own name survives a navigation
    return window.name.startsWith(NAME_PREFIX) ? Number(window.name.slice(NAME_PREFIX.length)) : null;
  }
}

function write(at: number | null): void {
  try {
    if (at === null) window.sessionStorage.removeItem(KEY);
    else window.sessionStorage.setItem(KEY, String(at));
    return;
  } catch {}
  if (at !== null) window.name = `${NAME_PREFIX}${at}`;
  else if (window.name.startsWith(NAME_PREFIX)) window.name = "";
}

/** Whether a bounce to /login was already made for this tab inside the window. */
export function bouncedRecently(now = Date.now()): boolean {
  const at = read();
  return at !== null && Number.isFinite(at) && now - at < BOUNCE_WINDOW_MS;
}

/**
 * A hard navigation to /login, never the client router: /login may answer with a redirect to an API
 * route (the router fetches that as a page and ends blank). The URL carries the base path the app is
 * served under, which a bare "/login" left out.
 */
export function goToLogin(): void {
  window.location.assign(new URL(assetPath("/login"), window.location.origin));
}

// What the last bounce decided, as a store a component reads with useSyncExternalStore.
let outcome: "left" | "stopped" | null = null;
const listeners = new Set<() => void>();
function settle(next: typeof outcome): void {
  if (next === outcome) return;
  outcome = next;
  for (const listener of listeners) listener();
}
export function subscribeBounce(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
export const bounceOutcome = (): typeof outcome => outcome;

/**
 * Sends the browser to /login once. Returns `stopped` where the previous navigation already
 * bounced, and then does not navigate.
 */
export function leaveForLogin(now = Date.now()): "left" | "stopped" {
  if (bouncedRecently(now)) {
    settle("stopped");
    return "stopped";
  }
  write(now);
  settle("left");
  goToLogin();
  return "left";
}

/** The session is open: the next sign-out is a first bounce again. */
export function clearBounce(): void {
  write(null);
  settle(null);
}
