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

/**
 * Failure text the RUNNER produced about its own environment, as opposed to the
 * agent's work. The runner emits `preflight_failed: <check>: <detail>` before
 * any agent starts (runner daemon/preflight.rs), so the prefix is a reliable
 * box-scoped marker.
 */
export function isBoxAttributable(error: string | null | undefined): boolean {
  return typeof error === 'string' && error.trimStart().startsWith('preflight_failed:');
}

/** Trim to the column's useful width; the full text stays on the job row. */
export function summarizeRunnerError(error: string): string {
  return error.trim().slice(0, 500);
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
  if (!runnerId || !isBoxAttributable(error)) return false;
  try {
    await db
      .update(runners)
      .set({ lastError: summarizeRunnerError(error as string), updatedAt: new Date() })
      .where(eq(runners.id, runnerId));
    logger.warn({ runnerId, error }, 'runner: box-scoped failure attributed');
    return true;
  } catch (err) {
    logger.error({ err, runnerId }, 'runner: failed to attribute box-scoped failure');
    return false;
  }
}
