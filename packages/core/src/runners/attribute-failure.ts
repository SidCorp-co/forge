// Attribute a box-scoped job failure to the box that caused it (ISS-806).
//
// `runners.lastError` had exactly one writer: the dispatcher, when handing a job
// OVER fails. A runner that accepts a job and then fails its own preflight wrote
// nothing — so on pixelight three boxes failed every push-bearing job for three
// days while `forge_runners list` reported `status: online, lastError: null`.
// An operator read a healthy fleet (VISION No.10).
//
// Attribution, not retry policy: whether to keep retrying such a failure is the
// classifier's job (ISS-757/ISS-812). This only makes the answer to "which box"
// readable without SSH-ing into each one and diffing git config by hand.

import { eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { runners } from '../db/schema.js';
import { logger } from '../logger.js';

const PREFLIGHT_PREFIX = 'preflight_failed:';

/** Job error the ack hop writes when no runner ever claimed the dispatch. */
// cm:edge contract -> packages/core/src/jobs/loop-monitor.ts — this is `reapAckMisses`'s `cfg.error`, persisted verbatim to `jobs.error`; the two spellings must match or a no-ack box stops being attributable and quarantine goes blind again
export const NO_ACK_ERROR = 'dispatch_unclaimed';

const NO_ACK_SUMMARY =
  'dispatch_unclaimed: accepted the dispatch and never claimed it (no ack, zero job events)';

/** A failure the BOX owns, as opposed to one the agent's work produced. */
export interface BoxFault {
  /** What two failures must SHARE to count as the same fault repeating. */
  key: string;
  /** What `runners.lastError` should read while this fault stands. */
  summary: string;
}

/**
 * Classify a job failure as box-scoped, or null when the box does not own it.
 *
 * Two classes qualify, and they are deliberately not interchangeable:
 * `preflight_failed: <check>` is the runner reporting on its own environment
 * before any agent starts (runner daemon/preflight.rs), keyed per check;
 * `dispatch_unclaimed` is the runner accepting work and never starting it.
 */
// cm:guard `session_lost` MUST NOT be added here — an agent session that started and then died can die from the agent's OWN work (OOM, a prompt that wedges the CLI), and every consumer of a BoxFault says something about the BOX. `dispatch_unclaimed` is safe precisely because the ack hop's predicate proves zero job events and no ack, which no agent behaviour can produce.
export function classifyBoxFault(error: string | null | undefined): BoxFault | null {
  if (typeof error !== 'string') return null;
  const text = error.trim();
  if (text.startsWith(PREFLIGHT_PREFIX)) {
    const check = text.slice(PREFLIGHT_PREFIX.length).split(':')[0]?.trim();
    return check ? { key: `${PREFLIGHT_PREFIX} ${check}`, summary: summarize(text) } : null;
  }
  if (text === NO_ACK_ERROR) return { key: NO_ACK_ERROR, summary: NO_ACK_SUMMARY };
  return null;
}

/** Trim to the column's useful width; the full text stays on the job row. */
function summarize(error: string): string {
  return error.slice(0, 500);
}

/**
 * Record a box-scoped failure on the runner so the fleet view stops claiming
 * health it does not have. Best-effort by contract: attribution must never
 * break the failure path it observes.
 */
export async function attributeFailureToRunner(
  runnerId: string | null | undefined,
  error: string | null | undefined,
): Promise<boolean> {
  const fault = classifyBoxFault(error);
  if (!runnerId || !fault) return false;
  try {
    await db
      .update(runners)
      .set({ lastError: fault.summary, updatedAt: new Date() })
      .where(eq(runners.id, runnerId));
    logger.warn({ runnerId, error }, 'runner: box-scoped failure attributed');
    return true;
  } catch (err) {
    logger.error({ err, runnerId }, 'runner: failed to attribute box-scoped failure');
    return false;
  }
}
