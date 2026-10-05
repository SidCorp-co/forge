import { scrubSentryEvent } from '@forge/observability';
import * as Sentry from '@sentry/node';
import { withoutQueryParams } from '../../lib/db-errors.js';
import { provideErrorTracker } from '../../lib/error-tracking.js';
import { sourceCommit } from '../../lib/source-commit.js';

let installed = false;

/** The shared scrub, after a failed query's params are redacted from the exception it reports. */
function sentryBeforeSend<E extends Parameters<typeof scrubSentryEvent>[0]>(
  event: E,
  hint: { originalException?: unknown },
): E {
  return scrubSentryEvent(withoutQueryParams(event, hint.originalException));
}

/**
 * Forge's own error reporting, behind the error-tracking port: installs @sentry/node as the port's
 * tracker when SENTRY_DSN is set. False when it is not, and the port then drops every report.
 */
export function installSentryErrorTracking(): boolean {
  if (installed) return true;
  const dsn = process.env.SENTRY_DSN;
  if (!dsn) return false;
  Sentry.init({
    dsn,
    release: sourceCommit ?? undefined,
    environment: process.env.NODE_ENV || 'development',
    tracesSampleRate: 0,
    sendDefaultPii: false,
    beforeSend: sentryBeforeSend,
  });
  provideErrorTracker({
    captureException: (err, context) => Sentry.captureException(err, context),
    captureMessage: (message, context) => Sentry.captureMessage(message, context),
    addBreadcrumb: (step) => Sentry.addBreadcrumb(step),
    flush: (timeoutMs) => Sentry.flush(timeoutMs),
  });
  installed = true;
  return true;
}
