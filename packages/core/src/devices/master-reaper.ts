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
// cm:guard LEFT JOIN, and the `held_at` bound applies to the SESSION-LESS arm only. A master is a bare Claude process that invents its own session id and writes no `agent_sessions` row, so the inner join this replaced matched nothing and reaped nothing — measured live 2026-09-05, a job sat held by a master 40 minutes dead, offered to no one and swept by nothing. A holder with no row cannot be judged by a heartbeat, so age is the only evidence there is; putting that clock on the other two arms instead would delay a KNOWN-dead master's holds by three minutes for no reason.
// cm:guard drop the HOLD and nothing else — never the dispatch stamp. Every job this can reach is still `queued`, because `startJobForMaster` clears the hold in the same statement that stamps; so a reaper that also unwound a stamp could only ever hit a job it had no business touching. It did, on epodsystem 2026-09-05: jobs f7f4bce4 and 8b8b7be4 were re-queued with `device_id` NULL while their agents were alive, and every event those agents posted came back 403 at 2/s with nothing able to stop them.
// cm:edge lockstep -> packages/core/src/devices/claim.ts — `releaseJobFromMaster` is the same operation on one row, and both must stay hold-only; a path that also cleared a stamp would revive the epodsystem wedge from whichever route still had it.
export async function reapDeadMasterHolds(): Promise<number> {
  // cm:guard the cutoff is computed by POSTGRES, not by node. A `Date` bound as a parameter through this driver throws at bind time, and — worse if it did not — a clock skew between the app host and the database would decide which masters count as dead.
  const staleSeconds = Math.floor(MASTER_HOLD_TIMEOUT_MS / 1000);

  const rows = (await db.execute(sql`
    WITH doomed AS (
      SELECT j.id, j.held_by,
             COALESCE(s.status, 'no_session') AS master_status
      FROM jobs j
      LEFT JOIN agent_sessions s ON s.id = j.held_by
      WHERE j.held_by IS NOT NULL
        AND (
          s.status IN (${TERMINAL})
          OR COALESCE(s.last_heartbeat_at, s.started_at)
             < now() - make_interval(secs => ${staleSeconds})
          OR (s.id IS NULL AND j.held_at < now() - make_interval(secs => ${staleSeconds}))
        )
    )
    UPDATE jobs
    SET held_by = NULL, held_at = NULL
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
    SET held_by = NULL, held_at = NULL
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
