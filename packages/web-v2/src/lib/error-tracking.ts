import { scrubLogRecord } from "@forge/observability";

type ReportLevel = "fatal" | "error" | "warning" | "info" | "debug";

interface ReportContext {
  level?: ReportLevel;
  tags?: Record<string, string>;
  extra?: Record<string, unknown>;
  contexts?: Record<string, Record<string, unknown>>;
}

/**
 * The browser's error-tracking port, the twin of core's lib/error-tracking.ts: where the cloud
 * UI's own failures leave for the operator's error tracker. The adapter behind it (lib/sentry.ts,
 * installed by providers/sentry-init) owns the SDK; every caller reports through the function
 * below and never reaches the SDK around them.
 */
export interface ErrorTracker {
  captureException(err: unknown, context: ReportContext): void;
}

let tracker: ErrorTracker | null = null;

export function provideErrorTracker(next: ErrorTracker | null): void {
  tracker = next;
}

/** What crosses the port is scrubbed here as well as in the adapter's own event hook. */
function scrubbed(context: ReportContext): ReportContext {
  return {
    ...context,
    ...(context.extra === undefined ? {} : { extra: scrubLogRecord(context.extra) }),
    ...(context.contexts === undefined ? {} : { contexts: scrubLogRecord(context.contexts) }),
  };
}

/** A failure the UI hit and could not recover from in place. Never throws. */
export function reportFailure(err: unknown, context: ReportContext = {}): void {
  if (!tracker) return;
  try {
    tracker.captureException(err, scrubbed(context));
  } catch {
    // Reporting is best-effort: a failed report never becomes the caller's failure.
  }
}
