import * as Sentry from "@sentry/react";
import { scrubSentryEvent } from "@forge/observability";
import { provideErrorTracker } from "./error-tracking";
import { sourceCommit } from "./source-commit";

let installed = false;

/**
 * The browser's own error reporting, behind the error-tracking port: installs @sentry/react as the
 * port's tracker when NEXT_PUBLIC_SENTRY_DSN is set. False when it is not, and the port then drops
 * every report. The one module in web-v2 that imports the SDK.
 */
export function installSentryErrorTracking(): boolean {
  if (installed) return true;
  const dsn = process.env.NEXT_PUBLIC_SENTRY_DSN;
  if (!dsn) return false;
  Sentry.init({
    dsn,
    release: sourceCommit ?? undefined,
    environment: process.env.NEXT_PUBLIC_SENTRY_ENV ?? "production",
    tracesSampleRate: 0,
    sendDefaultPii: false,
    beforeSend: scrubSentryEvent,
  });
  provideErrorTracker({
    captureException: (err, context) => Sentry.captureException(err, context),
    captureMessage: (message, context) => Sentry.captureMessage(message, context),
    addBreadcrumb: (step) => Sentry.addBreadcrumb(step),
  });
  installed = true;
  return true;
}
