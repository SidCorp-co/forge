import { and, eq, notInArray, sql } from 'drizzle-orm';
import { transitionSessions } from '../agent-sessions/session-transition.js';
import { db } from '../db/client.js';
import { agentSessions, terminalAgentSessionStatuses } from '../db/schema.js';
import { releaseHoldsOf, releaseHoldsOfDeadMasters } from '../jobs/index.js';
import { MASTER_SESSION_KIND } from '../jobs/session-kinds.js';
import { logger } from '../observability/logger.js';
import { masterSilentSql } from './master-silence.js';
import { SESSION_SILENCE_TIMEOUT_S } from './session-silence.js';

const TERMINAL = sql.raw(terminalAgentSessionStatuses.map((s) => `'${s}'`).join(', '));

/**
 * Close the master sessions whose box has stopped answering, and say how many.
 * Flipping the row terminal invokes the descent in `agent-sessions/session-transition.ts:transitionSessions`,
 * which returns the children's issue leases.
 */
export async function reapSilentMasters(): Promise<number> {
  const silent = (await db.execute(sql`
    SELECT s.id, s.device_id, s.project_id
    FROM agent_sessions s
    WHERE s.kind = ${MASTER_SESSION_KIND}
      AND s.status NOT IN (${TERMINAL})
      AND ${masterSilentSql('s')}
  `)) as unknown as Array<Record<string, unknown>>;

  let closed = 0;
  for (const row of silent) {
    const sessionId = String(row.id);
    const flipped = (
      await transitionSessions(db, {
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
      })
    ).rows;
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
 * Release holds belonging to master sessions that are terminal or silent, and
 * log each holder so the pool tells "nobody wanted this" from "its holder died".
 *
 * The silence arm carries the SAME child-liveness guard as
 * {@link reapSilentMasters}: without it the box that function spares loses every
 * job it held one statement later. A TERMINAL master is not guarded.
 */
export async function reapDeadMasterHolds(): Promise<number> {
  const released = await releaseHoldsOfDeadMasters(masterSilentSql, SESSION_SILENCE_TIMEOUT_S);
  for (const row of released) {
    logger.warn(
      { jobId: row.jobId, masterSessionId: row.formerHolder, masterStatus: row.masterStatus },
      'master-reaper: released a hold whose master is gone',
    );
  }
  return released.length;
}

/**
 * Release the holds of one named session, for the daemon's socket-drop path.
 *
 * Distinct from {@link reapDeadMasterHolds} in trigger only — the daemon knows
 * immediately, where the sweep has to wait out a timeout it cannot shorten.
 */
export async function releaseHoldsForSession(sessionId: string): Promise<number> {
  const released = await releaseHoldsOf(sessionId);
  if (released > 0) {
    logger.info(
      { masterSessionId: sessionId, released },
      'master-reaper: master disconnected, holds returned to the pool',
    );
  }
  return released;
}
