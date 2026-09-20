import { and, eq, notInArray, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { agentSessions, terminalAgentSessionStatuses } from '../db/schema.js';
import { MASTER_SESSION_KIND } from '../jobs/session-kinds.js';
import { applyKernelTransition } from '../lifecycle/transition.js';
import { logger } from '../logger.js';
import { SESSION_SILENCE_TIMEOUT_S } from './session-silence.js';

const TERMINAL = sql.raw(terminalAgentSessionStatuses.map((s) => `'${s}'`).join(', '));

/**
 * Close the master sessions whose box has stopped answering, and say how many.
 *
 * Flipping the row terminal is what invokes the descent in
 * `applyKernelTransition`, which is what returns the children's issue leases.
 *
 * A master is silent only if the sessions it OWNS are: a child that beat inside
 * the window means the box is alive with a broken heartbeat on the master, and
 * reaping there would return a lease under a run still working. The child's
 * life keeps the parent; the parent's death closes the child.
 *
 * "Owns" is the immediate edge, not the whole subtree. A master's children are
 * the runs it started; a chat forked under one of those is somebody reading, and
 * it is not evidence that this box is still dispatching.
 *
 * A child counts only once it has REPORTED — `last_heartbeat_at` or
 * `started_at`, with no fall back to `created_at`. `prepareClaimedJob` mints a
 * queued child the instant a job is prepared, so reading creation time as life
 * would let a master that prepared one job and died immediately keep its hold
 * for the whole window on the strength of a row that never ran.
 */
export async function reapSilentMasters(): Promise<number> {
  const staleSeconds = SESSION_SILENCE_TIMEOUT_S;
  const silent = (await db.execute(sql`
    SELECT s.id, s.device_id, s.project_id
    FROM agent_sessions s
    WHERE s.kind = ${MASTER_SESSION_KIND}
      AND s.status NOT IN (${TERMINAL})
      AND COALESCE(s.last_heartbeat_at, s.started_at, s.created_at)
          < now() - make_interval(secs => ${staleSeconds})
      AND NOT EXISTS (
        SELECT 1 FROM agent_sessions c
        WHERE c.parent_session_id = s.id
          AND c.status NOT IN (${TERMINAL})
          AND COALESCE(c.last_heartbeat_at, c.started_at)
              >= now() - make_interval(secs => ${staleSeconds})
      )
  `)) as unknown as Array<Record<string, unknown>>;

  let closed = 0;
  for (const row of silent) {
    const sessionId = String(row.id);
    const flipped = await applyKernelTransition(db, {
      entity: 'session',
      to: 'failed',
      set: {
        failureReason: 'runner_unreachable',
        failureDetail: 'master-reaper: heartbeat stopped',
        updatedAt: new Date(),
      },
      where: and(
        eq(agentSessions.id, sessionId),
        notInArray(agentSessions.status, [...terminalAgentSessionStatuses]),
      ),
      returning: ['id'],
      reason: 'master_session_box_silent',
      actor: { type: 'system' },
      source: 'master-reaper',
    });
    if (flipped.length === 0) continue;
    closed += 1;
    await releaseHoldsForSession(sessionId);
    logger.warn(
      {
        masterSessionId: sessionId,
        deviceId: row.device_id ? String(row.device_id) : null,
        projectId: row.project_id ? String(row.project_id) : null,
      },
      'master-reaper: a master and everything it owned went silent, so it was closed',
    );
  }
  return closed;
}

/**
 * Release holds belonging to master sessions that are terminal or silent.
 *
 * Returns the number of jobs handed back, and logs each holder so an operator
 * reading the pool can tell "nobody wanted this" from "its holder died".
 *
 * The silence arm carries the SAME child-liveness guard as
 * {@link reapSilentMasters}, and it has to: without it, a box that is plainly
 * alive with a broken master heartbeat keeps its master row — because that
 * function protected it — and loses every job it was holding one statement
 * later, which is the protection undone by the sweep that runs beside it. A
 * TERMINAL master is not guarded: it is dead whatever its children are doing,
 * and the descent has already closed them.
 */
export async function reapDeadMasterHolds(): Promise<number> {
  const staleSeconds = SESSION_SILENCE_TIMEOUT_S;

  const rows = (await db.execute(sql`
    WITH doomed AS (
      SELECT j.id, j.held_by,
             COALESCE(s.status, 'no_session') AS master_status
      FROM jobs j
      LEFT JOIN agent_sessions s ON s.id = j.held_by
      WHERE j.held_by IS NOT NULL
        AND (
          s.status IN (${TERMINAL})
          OR (
            COALESCE(s.last_heartbeat_at, s.started_at)
              < now() - make_interval(secs => ${staleSeconds})
            AND NOT EXISTS (
              SELECT 1 FROM agent_sessions c
              WHERE c.parent_session_id = s.id
                AND c.status NOT IN (${TERMINAL})
                AND COALESCE(c.last_heartbeat_at, c.started_at)
                    >= now() - make_interval(secs => ${staleSeconds})
            )
          )
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

export async function registerMasterReaper(): Promise<void> {
  if (registered) return;
  const { boss } = await import('../queue/boss.js');
  // biome-ignore lint/suspicious/noExplicitAny: pg-boss types vary across versions
  await (boss as any).createQueue(MASTER_REAPER_QUEUE);
  // biome-ignore lint/suspicious/noExplicitAny: pg-boss types vary across versions
  await (boss as any).work(MASTER_REAPER_QUEUE, async () => {
    // Masters first: closing one returns its own holds and, through the
    // descent, its children's leases. The hold sweep that follows catches what
    // no transition can reach — a hold whose session row is gone entirely, and
    // one whose master this pass declined to close.
    const closed = await reapSilentMasters();
    if (closed > 0) logger.info({ closed }, 'master-reaper: sweep closed silent masters');
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
