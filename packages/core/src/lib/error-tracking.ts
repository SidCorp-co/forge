import { scrubLogRecord, scrubLogText } from '@forge/observability';

type ReportLevel = 'fatal' | 'error' | 'warning' | 'info' | 'debug';

interface ReportContext {
  level?: ReportLevel;
  tags?: Record<string, string>;
  extra?: Record<string, unknown>;
}

interface TraceStep {
  category: string;
  level?: ReportLevel;
  message?: string;
  data?: Record<string, unknown>;
}

/**
 * The error-tracking port: where Forge's own failures leave for the operator's error tracker. The
 * adapter behind it (integrations/sentry, installed at boot) owns the SDK; every caller reports
 * through the functions below and never reaches the SDK around them.
 */
export interface ErrorTracker {
  captureException(err: unknown, context: ReportContext): void;
  captureMessage(message: string, context: ReportContext): void;
  addBreadcrumb(step: TraceStep): void;
  flush(timeoutMs: number): Promise<unknown>;
}

let tracker: ErrorTracker | null = null;

export function provideErrorTracker(next: ErrorTracker): void {
  tracker = next;
}

export function isErrorTrackingEnabled(): boolean {
  return tracker !== null;
}

/** What crosses the port is scrubbed here as well as in the adapter's own event hook. */
function scrubbed(context: ReportContext): ReportContext {
  return context.extra === undefined
    ? context
    : { ...context, extra: scrubLogRecord(context.extra) };
}

/** A failure Forge itself hit and could not recover from in place. Never throws. */
export function reportFailure(err: unknown, context: ReportContext = {}): void {
  if (!tracker) return;
  try {
    tracker.captureException(err, scrubbed(context));
  } catch {
    // Reporting is best-effort: a failed report never becomes the caller's failure.
  }
}

/** A condition worth an operator's attention that is not an exception. Never throws. */
export function reportCondition(message: string, context: ReportContext = {}): void {
  if (!tracker) return;
  try {
    tracker.captureMessage(scrubLogText(message), scrubbed(context));
  } catch {
    // Best-effort, as above.
  }
}

/** A step recorded beside whatever failure is reported next in this process. */
export function traceStep(step: TraceStep): void {
  if (!tracker) return;
  tracker.addBreadcrumb(
    step.data === undefined ? step : { ...step, data: scrubLogRecord(step.data) },
  );
}

/** Waits for queued reports to leave, for a process about to exit. */
export async function flushReports(timeoutMs: number): Promise<void> {
  if (!tracker) return;
  await tracker.flush(timeoutMs);
}
