/**
 * Giving back the work a master was holding when it stopped being able to.
 *
 * Two independent triggers, because the two failures do not look alike: the
 * daemon sees its local socket drop, and core sees a heartbeat stop. A box
 * that loses power produces only the second.
 */

import { sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { terminalAgentSessionStatuses } from '../db/schema.js';
import { logger } from '../logger.js';

// cm:edge lockstep -> packages/core/src/db/schema.ts — read the terminal set from `terminalAgentSessionStatuses` rather than restating it. A hand-written list here silently misses a status added there, and the miss is invisible: those masters' holds simply never come back, and the pool shrinks with nothing reporting why.
const TERMINAL = sql.raw(terminalAgentSessionStatuses.map((s) => `'${s}'`).join(', '));

/** How long a master session may go silent before its holds are given back. */
// cm:guard this must stay LONGER than a master's own loop interval or a healthy master has its work taken mid-decision, and SHORTER than the session residency ceiling or a dead master's jobs sit unclaimable until something else notices. The runner's socket-drop path is the fast trigger; this is the one that has to work when the box simply vanishes.
export const MASTER_HOLD_TIMEOUT_MS = 3 * 60 * 1000;

/**
 * Release holds belonging to master sessions that are terminal or silent.
 *
 * Returns the number of jobs handed back, and logs each holder so an operator
 * reading the pool can tell "nobody wanted this" from "its holder died".
 */
// cm:guard `acked_at` is what separates the two cases, and it must be the test rather than the status. A job the runner ACKED has a process behind it that outlives its master, so only the hold is dropped — killing it would throw away a diff nobody asked to discard. A `dispatched` job with no ack never reached a process: its master died between the claim and the spawn, and leaving it stamped makes it exactly the orphan the loop monitor exists to chase, held by nobody and claimable by no one.
// cm:edge lockstep -> packages/core/src/devices/claim.ts — `releaseJobFromMaster` unwinds the same three columns under the same `acked_at IS NULL` condition; one path undoing the stamp and the other not is a job that is claimable again on one route and stranded on the other.
export async function reapDeadMasterHolds(): Promise<number> {
  // cm:guard the cutoff is computed by POSTGRES, not by node. A `Date` bound as a parameter through this driver throws at bind time, and — worse if it did not — a clock skew between the app host and the database would decide which masters count as dead.
  const staleSeconds = Math.floor(MASTER_HOLD_TIMEOUT_MS / 1000);

  const rows = (await db.execute(sql`
    WITH gone AS (
      SELECT s.id, s.status
      FROM agent_sessions s
      WHERE s.status IN (${TERMINAL})
         OR COALESCE(s.last_heartbeat_at, s.started_at)
            < now() - make_interval(secs => ${staleSeconds})
    )
    , doomed AS (
      SELECT j.id, j.held_by, g.status AS master_status
      FROM jobs j JOIN gone g ON g.id = j.held_by
    )
    UPDATE jobs
    SET held_by = NULL, held_at = NULL,
        status = CASE WHEN jobs.status = 'dispatched' AND jobs.acked_at IS NULL
                      THEN 'queued' ELSE jobs.status END,
        device_id = CASE WHEN jobs.status = 'dispatched' AND jobs.acked_at IS NULL
                         THEN NULL ELSE jobs.device_id END,
        dispatched_at = CASE WHEN jobs.status = 'dispatched' AND jobs.acked_at IS NULL
                             THEN NULL ELSE jobs.dispatched_at END
    WHERE id IN (SELECT id FROM doomed)
    RETURNING id, (SELECT held_by FROM doomed d WHERE d.id = jobs.id) AS former_holder,
              (SELECT master_status FROM doomed d WHERE d.id = jobs.id) AS master_status
  `)) as unknown as Array<Record<string, unknown>>;

  for (const row of rows) {
    logger.warn(
      {
        jobId: String(row.id),
        masterSessionId: String(row.former_holder),
        masterStatus: String(row.master_status),
      },
      'master-reaper: released a hold whose master is gone',
    );
  }
  return rows.length;
}

export const MASTER_REAPER_QUEUE = 'master-hold-reaper';

let registered = false;

/**
 * Run the sweep on a schedule.
 *
 * Every minute, not every two: the reaper is the only thing that recovers a
 * hold when a box vanishes without dropping its socket, and its own timeout
 * already costs three.
 */
export async function registerMasterReaper(): Promise<void> {
  if (registered) return;
  const { boss } = await import('../queue/boss.js');
  // biome-ignore lint/suspicious/noExplicitAny: pg-boss types vary across versions
  await (boss as any).createQueue(MASTER_REAPER_QUEUE);
  // biome-ignore lint/suspicious/noExplicitAny: pg-boss types vary across versions
  await (boss as any).work(MASTER_REAPER_QUEUE, async () => {
    const released = await reapDeadMasterHolds();
    if (released > 0) logger.info({ released }, 'master-reaper: sweep returned holds to the pool');
  });
  // biome-ignore lint/suspicious/noExplicitAny: pg-boss types vary across versions
  await (boss as any).schedule(MASTER_REAPER_QUEUE, '* * * * *');
  registered = true;
}

export function resetMasterReaperForTest(): void {
  registered = false;
}

/**
 * Release the holds of one named session, for the daemon's socket-drop path.
 *
 * Distinct from {@link reapDeadMasterHolds} in trigger only — the daemon knows
 * immediately, where the sweep has to wait out a timeout it cannot shorten.
 */
export async function releaseHoldsForSession(sessionId: string): Promise<number> {
  const rows = (await db.execute(sql`
    UPDATE jobs
    SET held_by = NULL, held_at = NULL,
        status = CASE WHEN jobs.status = 'dispatched' AND jobs.acked_at IS NULL
                      THEN 'queued' ELSE jobs.status END,
        device_id = CASE WHEN jobs.status = 'dispatched' AND jobs.acked_at IS NULL
                         THEN NULL ELSE jobs.device_id END,
        dispatched_at = CASE WHEN jobs.status = 'dispatched' AND jobs.acked_at IS NULL
                             THEN NULL ELSE jobs.dispatched_at END
    WHERE held_by = ${sessionId}
    RETURNING id
  `)) as unknown as Array<Record<string, unknown>>;

  if (rows.length > 0) {
    logger.info(
      { masterSessionId: sessionId, released: rows.length },
      'master-reaper: master disconnected, holds returned to the pool',
    );
  }
  return rows.length;
}
