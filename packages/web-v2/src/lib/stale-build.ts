/**
 * A tab opened before a deploy asks for the old build's files when it opens a screen it has not
 * loaded yet, and they are gone: the import fails and the screen never opens. Vite says so with
 * `vite:preloadError`; the page reloads once to fetch the current build. A second failure within
 * the window is left to throw, so a real outage still shows and still reaches Sentry.
 */

const KEY = "forge:stale-build-reload-at";
const WINDOW_MS = 60_000;

interface Deps {
  now(): number;
  reload(): void;
  storage: Pick<Storage, "getItem" | "setItem"> | null;
}

/** Whether this failure reloads the page: none was reloaded for within the window. */
export function reloadForStaleBuild(deps: Deps): boolean {
  let last = Number.NaN;
  try {
    const held = deps.storage?.getItem(KEY);
    if (held) last = Number(held);
  } catch {
    // storage refused (private window, blocked site data): reload once, as on a first failure
  }
  const now = deps.now();
  if (Number.isFinite(last) && now - last < WINDOW_MS) return false;
  try {
    deps.storage?.setItem(KEY, String(now));
  } catch {
    // storage refused: nothing remembers this reload, so a second failure after it reloads again
  }
  deps.reload();
  return true;
}

/** Listen for a stale build's failed import on `target` (the window). */
export function reloadOnStaleBuild(target: Window): void {
  target.addEventListener("vite:preloadError", (event) => {
    const reloaded = reloadForStaleBuild({
      now: () => Date.now(),
      reload: () => target.location.reload(),
      storage: (() => {
        try {
          return target.sessionStorage;
        } catch {
          return null;
        }
      })(),
    });
    if (reloaded) event.preventDefault();
  });
}
