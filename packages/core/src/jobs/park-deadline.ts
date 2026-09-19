import { and, eq, type SQL, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { agentSessions } from '../db/schema.js';
import { agentQuestions } from '../db/schema-questions.js';
import { applyKernelTransition } from '../lifecycle/transition.js';
import { logger } from '../logger.js';
import type { LoopScope } from './loop-monitor.js';
import { NEVER_PARKED_METADATA_TYPES } from './session-kinds.js';

const DEFAULT_RESIDENCY_SECONDS = 10 * 60;

const PARK_GRACE_SECONDS = 5 * 60;

const RESIDENCY_DEADLINE = sql`
  COALESCE(${agentSessions.lastHeartbeatAt}, ${agentSessions.createdAt})
    < now() - make_interval(secs => ${PARK_GRACE_SECONDS} + COALESCE((
        SELECT (p.agent_config -> 'pipelineConfig' ->> 'sessionResidencySeconds')::int
        FROM projects p WHERE p.id = agent_sessions.project_id
      ), ${DEFAULT_RESIDENCY_SECONDS}))`;

/**
 * Whether the session at `sessionId` is parked on a person right now.
 */
export const parkedOnAHuman = (sessionId: SQL): SQL => sql`
  EXISTS (
    SELECT 1 FROM agent_questions q
     WHERE q.agent_session_id = ${sessionId}
       AND q.status = 'open'
       AND q.blocker_kind = 'human'
  )`;

const NOT_A_PROCESSLESS_PARK = sql`NOT ${parkedOnAHuman(sql`agent_sessions.id`)}`;

/**
 * Hop 3b — the residency deadline. A session parked past its runner's ceiling
 * plus a grace: the runner is presumed gone, so close the row and free the slot.
 */
export async function reapExpiredParks(
  now: Date = new Date(),
  scope: LoopScope = {},
): Promise<number> {
  const reaped = await applyKernelTransition(db, {
    entity: 'session',
    to: 'failed',
    set: { failureReason: 'residency_expired', updatedAt: now },
    where: and(
      eq(agentSessions.status, 'running'),
      eq(agentSessions.runtimeState, 'awaiting_input'),
      RESIDENCY_DEADLINE,
      NOT_A_PROCESSLESS_PARK,
      ...(scope.projectId ? [eq(agentSessions.projectId, scope.projectId)] : []),
    ),
    fromStatus: 'running',
    reason: 'residency_expired',
    actor: { type: 'sweeper' },
    source: 'loop-monitor',
  });

  if (reaped.length > 0) {
    logger.info({ reaped: reaped.length }, 'loop-monitor: parks past their residency deadline');
  }
  return reaped.length;
}

/** One park past the deadline its asker set, and how long it went unanswered. */
type UnansweredPark = { sessionId: string; questionId: string; days: number };

async function unansweredParks(now: Date, scope: LoopScope): Promise<UnansweredPark[]> {
  const at = now.toISOString();
  const rows = await db.execute<{
    question_id: string;
    session_id: string;
    days: number;
  }>(sql`
    SELECT q.id AS question_id,
           q.agent_session_id AS session_id,
           GREATEST(1, FLOOR(EXTRACT(EPOCH FROM (${at}::timestamptz - q.created_at)) / 86400))::int
             AS days
      FROM agent_questions q
      JOIN agent_sessions s ON s.id = q.agent_session_id
     WHERE q.status = 'open'
       AND q.blocker_kind = 'human'
       AND q.park_deadline_at IS NOT NULL
       AND q.park_deadline_at < ${at}::timestamptz
       AND s.status = 'running'
       AND COALESCE(s.metadata->>'type', '') NOT IN ${NEVER_PARKED_METADATA_TYPES}
       ${scope.projectId ? sql`AND q.project_id = ${scope.projectId}` : sql``}
  `);
  return rows.map((r) => ({
    sessionId: r.session_id,
    questionId: r.question_id,
    days: r.days,
  }));
}

/**
 * The clock that replaces residency for a park with no process.
 *
 * `reapExpiredParks` above exempts the human branch, so this is what keeps it
 * from being a park under no clock at all: the asker's own deadline, expiring
 * loudly and leaving the question in the bucket flagged `expired` rather than
 * removed (ISS-964 criterion 34).
 */
export async function reapUnansweredParks(
  now: Date = new Date(),
  scope: LoopScope = {},
): Promise<number> {
  const parks = await unansweredParks(now, scope);
  let closed = 0;

  for (const park of parks) {
    const endedReason = `unanswered_${park.days}d`;
    const moved = await applyKernelTransition(db, {
      entity: 'session',
      to: 'failed',
      set: { failureReason: 'park_unanswered', updatedAt: now },
      where: and(eq(agentSessions.id, park.sessionId), eq(agentSessions.status, 'running')),
      fromStatus: 'running',
      reason: endedReason,
      actor: { type: 'sweeper' },
      source: 'loop-monitor',
    });
    if (moved.length === 0) continue;

    await db
      .update(agentQuestions)
      .set({ status: 'expired', endedReason, endedBy: 'sweeper', updatedAt: now })
      .where(and(eq(agentQuestions.id, park.questionId), eq(agentQuestions.status, 'open')));
    closed += 1;
  }

  if (closed > 0) {
    logger.info({ closed }, 'loop-monitor: parks nobody answered before their deadline');
  }
  return closed;
}
