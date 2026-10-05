import { scrubSentryEvent } from '@forge/observability';
import * as Sentry from '@sentry/node';
import { withoutQueryParams } from './db-errors.js';
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
function sentryBeforeSend<E extends Parameters<typeof scrubSentryEvent>[0]>(
  event: E,
  hint: { originalException?: unknown },
): E {
  return scrubSentryEvent(withoutQueryParams(event, hint.originalException));
}

export function isSentryEnabled(): boolean {
  return initialized;
}

type ReportLevel = 'fatal' | 'error' | 'warning' | 'info' | 'debug';

interface ReportContext {
  level?: ReportLevel;
  tags?: Record<string, string>;
  extra?: Record<string, unknown>;
}

/** A failure Forge itself hit and could not recover from in place. Never throws. */
export function reportFailure(err: unknown, context: ReportContext = {}): void {
  if (!initialized) return;
  try {
    Sentry.captureException(err, context);
  } catch {
    // Reporting is best-effort: a failed report never becomes the caller's failure.
  }
}

/** A condition worth an operator's attention that is not an exception. Never throws. */
export function reportCondition(message: string, context: ReportContext = {}): void {
  if (!initialized) return;
  try {
    Sentry.captureMessage(message, context);
  } catch {
    // Best-effort, as above.
  }
}

/** A step recorded beside whatever failure is reported next in this process. */
export function traceStep(step: {
  category: string;
  level?: ReportLevel;
  message?: string;
  data?: Record<string, unknown>;
}): void {
  if (!initialized) return;
  Sentry.addBreadcrumb(step);
}

/** Waits for queued reports to leave, for a process about to exit. */
export async function flushReports(timeoutMs: number): Promise<void> {
  if (!initialized) return;
  await Sentry.flush(timeoutMs);
}
