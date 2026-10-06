import { QUESTION_MACHINE } from '@forge/contracts/question-machine';
import { and, eq, notInArray, type SQL, sql } from 'drizzle-orm';
import {
  closeResidentOnBox,
  endLapsedResidency,
  transitionSessions,
} from '../agent-sessions/index.js';
import { db } from '../db/client.js';
import { agentSessions } from '../db/schema.js';
import { agentQuestions } from '../db/schema-questions.js';
import { logger } from '../lib/logger.js';
import { transition } from '../lifecycle/index.js';
import type { LoopScope } from './loop-monitor.js';
import { CLIENT_SESSION_KINDS, kindTuple, NEVER_PARKED_SESSION_KINDS } from './session-kinds.js';

/**
 * How long a session may wait for its next turn in a resident process before its residency ends
 * (ADR 0009, What core takes over: Idle verdict). The box keeps no clock of its own.
 */
const RESIDENCY_SECONDS = 10 * 60;

/** How long core keeps telling a box to close a resident chat session before it reads the box as gone. */
const RESIDENCY_ANSWER_SECONDS = 60 * 60;

/** How long past the residency a job-linked park is kept before its process is presumed gone. */
const PARK_GRACE_SECONDS = 5 * 60;

/** A session's beat, the clock both residency verdicts measure from. */
const BEAT = sql`COALESCE(${agentSessions.lastHeartbeatAt}, ${agentSessions.createdAt})`;

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
 * Hop 3b — the residency deadline on a job-linked park: a session parked in its process past the
 * residency plus a grace is failed, its process presumed gone. Only a runner older than 0.13.0 parks
 * a job-linked session (the job pool that did went in ddabc1f2b); a chat session is
 * `closeIdleResidents`'s alone, so one session has one residency clock. Priced in
 * `.forge/conformance.json` `$amnesties` as `job-linked-park-clock`.
 */
export async function reapExpiredParks(
  now: Date = new Date(),
  scope: LoopScope = {},
): Promise<number> {
  const reaped = (
    await transitionSessions(db, {
      to: 'failed',
      set: { failureReason: 'residency_expired', updatedAt: now },
      where: and(
        eq(agentSessions.status, 'running'),
        eq(agentSessions.runtimeState, 'awaiting_input'),
        notInArray(agentSessions.kind, [...CLIENT_SESSION_KINDS]),
        sql`${BEAT} < ${now.toISOString()}::timestamptz - make_interval(secs => ${RESIDENCY_SECONDS + PARK_GRACE_SECONDS})`,
        NOT_A_PROCESSLESS_PARK,
        ...(scope.projectId ? [eq(agentSessions.projectId, scope.projectId)] : []),
      ),
      reason: 'residency_expired',
      actor: { type: 'sweeper' },
      source: 'loop-monitor',
    })
  ).rows;

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
       AND s.kind NOT IN ${kindTuple(NEVER_PARKED_SESSION_KINDS)}
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
    const moved = (
      await transitionSessions(db, {
        to: 'failed',
        set: { failureReason: 'park_unanswered', updatedAt: now },
        where: and(eq(agentSessions.id, park.sessionId), eq(agentSessions.status, 'running')),
        reason: endedReason,
        actor: { type: 'sweeper' },
        source: 'loop-monitor',
      })
    ).rows;
    if (moved.length === 0) continue;

    await transition(db, QUESTION_MACHINE, {
      to: 'expired',
      from: 'open',
      set: { endedReason, endedBy: 'sweeper', updatedAt: now },
      where: eq(agentQuestions.id, park.questionId),
      reason: endedReason,
      actor: { type: 'sweeper' },
      source: 'loop-monitor',
      returning: ['id'],
    });
    closed += 1;
  }

  if (closed > 0) {
    logger.info({ closed }, 'loop-monitor: parks nobody answered before their deadline');
  }
  return closed;
}

/**
 * The idle verdict on a resident chat session, its one residency clock: one that has waited for its
 * next turn past the residency is told closed on its box with `agent:close`, every pass until the
 * box reports it closed. A box that has not answered within the hour after is read as gone, and the
 * row says the residency is over without it. A session with a turn in flight (`queued`/`running`)
 * is not waiting for one: its runtime state is still the one the turn before it ended on.
 */
export async function closeIdleResidents(
  now: Date = new Date(),
  scope: LoopScope = {},
): Promise<number> {
  const at = now.toISOString();
  const rows = await db.execute<{ id: string; device_id: string; lapsed: boolean }>(sql`
    SELECT ${agentSessions.id} AS id, ${agentSessions.deviceId} AS device_id,
           ${BEAT} < ${at}::timestamptz - make_interval(secs => ${RESIDENCY_SECONDS + RESIDENCY_ANSWER_SECONDS})
             AS lapsed
      FROM ${agentSessions}
     WHERE ${agentSessions.kind} IN ${kindTuple(CLIENT_SESSION_KINDS)}
       AND ${agentSessions.status} NOT IN ('queued', 'running')
       AND ${agentSessions.runtimeState} = 'awaiting_input'
       AND ${agentSessions.deviceId} IS NOT NULL
       AND ${BEAT} < ${at}::timestamptz - make_interval(secs => ${RESIDENCY_SECONDS})
       ${scope.projectId ? sql`AND ${agentSessions.projectId} = ${scope.projectId}` : sql``}
     ORDER BY ${BEAT} ASC
     LIMIT 500
  `);
  let told = 0;
  for (const row of rows) {
    if (row.lapsed) {
      await endLapsedResidency(row.id);
      continue;
    }
    await closeResidentOnBox(row.id, row.device_id);
    told += 1;
  }
  if (rows.length > 0) {
    logger.info(
      { told, lapsed: rows.length - told },
      'loop-monitor: resident sessions past their residency told closed',
    );
  }
  return told;
}
