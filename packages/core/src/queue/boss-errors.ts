// pg-boss reports what fails inside its own loops (a worker's fetch, settle or fail, a heartbeat,
// the maintenance and supervise passes, the queue-cache refresh) as an `error` event. An emitter
// with no `error` listener throws that event straight back out of emit(), inside a loop nothing
// awaits, so it surfaced as an unhandled rejection and the process exited with no line of ours
// (forge-dev, 2026-10-16, twice within seconds of issues being created). Listened to here, the same
// failure is one error line naming its queue and worker, counted where the ops snapshot reads it.
import { reportFailure } from '../lib/error-tracking.js';
import { logger } from '../lib/logger.js';

export type BossErrorTally = {
  count: number;
  last: { at: string; message: string; queue: string | null; worker: string | null } | null;
};

const tally: BossErrorTally = { count: 0, last: null };

const textOf = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);

/** pg-boss hands over an Error, or a plain copy of one carrying the queue and worker it hit. */
export function onBossError(raw: unknown): void {
  const fields = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>;
  const message = textOf(fields.message) ?? String(raw);
  const queue = textOf(fields.queue);
  const worker = textOf(fields.worker);
  const err =
    raw instanceof Error
      ? raw
      : Object.assign(new Error(message), { stack: textOf(fields.stack) ?? undefined });
  tally.count += 1;
  tally.last = { at: new Date().toISOString(), message, queue, worker };
  logger.error(
    { err, queue, worker, jobId: textOf(fields.jobId), bossErrors: tally.count },
    'pg-boss: a failure inside its own loop',
  );
  reportFailure(err, { tags: { source: 'pg-boss', ...(queue ? { queue } : {}) } });
}

/** How many pg-boss errors this process has seen since boot, and the latest. */
export function bossErrorTally(): BossErrorTally {
  return { count: tally.count, last: tally.last ? { ...tally.last } : null };
}
