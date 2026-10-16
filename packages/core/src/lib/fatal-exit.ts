// The last resort for a throw nothing caught: one fatal line saying what it was, then a non-zero
// exit. A process that survived an exception it did not expect is in a state nobody reasoned
// about, and a restart is the safer of the two; what this adds is that the restart is explained in
// our own log, where before Node's stack went only to stderr and the line nobody read.
import { flushReports, reportFailure } from './error-tracking.js';
import { logger } from './logger.js';

type FatalKind = 'uncaughtException' | 'unhandledRejection';

/** The longest an exit waits for a queued error report to leave. */
const FLUSH_MS = 2_000;

const textOf = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);

/** The queue and worker a pg-boss failure names, on the event itself or on the ERR_UNHANDLED_ERROR that wraps it. */
function whereOf(reason: unknown): { queue: string | null; worker: string | null } {
  const r = (typeof reason === 'object' && reason !== null ? reason : {}) as Record<
    string,
    unknown
  >;
  const ctx = (typeof r.context === 'object' && r.context !== null ? r.context : {}) as Record<
    string,
    unknown
  >;
  return {
    queue: textOf(r.queue) ?? textOf(ctx.queue),
    worker: textOf(r.worker) ?? textOf(ctx.worker),
  };
}

export function fatalExit(kind: FatalKind, reason: unknown, exit: (code: number) => void): void {
  const err =
    reason instanceof Error
      ? reason
      : new Error(textOf((reason as { message?: unknown } | null)?.message) ?? String(reason));
  logger.fatal({ err, kind, ...whereOf(reason) }, `@forge/core ${kind}, exiting: ${err.message}`);
  reportFailure(err, { level: 'fatal', tags: { kind } });
  // the backstop is not unref'd: the exit must happen whether or not the flush ever settles
  const backstop = setTimeout(() => exit(1), FLUSH_MS + 500);
  void flushReports(FLUSH_MS)
    .catch(() => undefined)
    .finally(() => {
      clearTimeout(backstop);
      exit(1);
    });
}

/** Installed once at boot, before anything starts work. The first fatal wins; a second is not logged over it. */
export function installFatalExit(
  exit: (code: number) => void = (code) => process.exit(code),
): void {
  let exiting = false;
  const on = (kind: FatalKind) => (reason: unknown) => {
    if (exiting) return;
    exiting = true;
    fatalExit(kind, reason, exit);
  };
  process.on('uncaughtException', on('uncaughtException'));
  process.on('unhandledRejection', on('unhandledRejection'));
}
