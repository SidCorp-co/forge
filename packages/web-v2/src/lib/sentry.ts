import * as Sentry from "@sentry/react";
import { scrubSentryEvent } from "@forge/observability";
import { provideErrorTracker } from "./error-tracking";
import { sourceCommit } from "./source-commit";

let installed = false;

/** What each browser's fetch throws when the request never got an answer (Chrome, Firefox, Safari). */
const NETWORK_FAILURE = /^(Failed to fetch|NetworkError when attempting to fetch resource\.?|Load failed)$/;

/**
 * One Sentry issue for every fetch that got no answer. Without it each bundle hash a deploy ships
 * opens a fresh issue (121 on forge-dev by 2026-11-07, every one a core restart), and the real
 * client errors drown in them.
 */
export function groupNetworkFailure<E extends { exception?: { values?: { type?: string; value?: string }[] }; fingerprint?: string[] }>(
  event: E,
): E {
  const thrown = event.exception?.values?.at(-1);
  if (thrown?.type === "TypeError" && NETWORK_FAILURE.test(thrown.value ?? "")) {
    event.fingerprint = ["browser-network-failure"];
  }
  return event;
}

/**
 * The browser's own error reporting, behind the error-tracking port: installs @sentry/react as the
 * port's tracker when VITE_SENTRY_DSN is set. False when it is not, and the port then drops
 * every report. The one module in web-v2 that imports the SDK.
 */
export function installSentryErrorTracking(): boolean {
  if (installed) return true;
  const dsn = import.meta.env.VITE_SENTRY_DSN;
  if (!dsn) return false;
  Sentry.init({
    dsn,
    release: sourceCommit ?? undefined,
    environment: import.meta.env.VITE_SENTRY_ENV ?? "production",
    tracesSampleRate: 0,
    sendDefaultPii: false,
    beforeSend: (event) => groupNetworkFailure(scrubSentryEvent(event)),
  });
  provideErrorTracker({
    captureException: Sentry.captureException,
  });
  installed = true;
  return true;
}
