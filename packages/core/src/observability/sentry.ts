import { scrubSentryEvent } from '@forge/observability';
import * as Sentry from '@sentry/node';
import { withoutQueryParams } from '../lib/db-errors.js';
import { sourceCommit } from './source-commit.js';

let initialized = false;

export function initSentry(): boolean {
  if (initialized) return true;
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
  initialized = true;
  return true;
}

/** The shared scrub, after a failed query's params are redacted from the exception it reports. */
export function sentryBeforeSend<E extends Parameters<typeof scrubSentryEvent>[0]>(
  event: E,
  hint: { originalException?: unknown },
): E {
  return scrubSentryEvent(withoutQueryParams(event, hint.originalException));
}

export function isSentryEnabled(): boolean {
  return initialized;
}

export { Sentry };
