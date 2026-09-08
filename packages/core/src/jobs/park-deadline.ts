// The backstop for a park whose runner never came back.
//
// Phase 2 exempted `awaiting_input` from the heartbeat hop, which is right — a
// session waiting on a human is not wedged. But it left the park bounded by
// exactly one thing: the runner's own idle ceiling. If that runner dies while a
// session is parked, nothing on this side ever closes the row, and one of the
// box's few duplex slots is gone until someone notices by hand.
//
// This is NOT a policy knob. It fires only when the runner failed to honour its
// own deadline, which is why the bound is residency PLUS a grace — core and the
// runner racing to close the same park would make the reason a coin flip.
//
// One clock, two thresholds: `lastHeartbeatAt` freezes at the last real
// activity when a session parks (agent-sessions/routes.ts deliberately does not
// bump it on `awaiting_input`), so it already IS the park clock.

import { and, eq, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { agentSessions } from '../db/schema.js';
import { agentQuestions } from '../db/schema-questions.js';
import { applyKernelTransition } from '../lifecycle/transition.js';
import { logger } from '../logger.js';
import type { LoopScope } from './loop-monitor.js';

// cm:edge lockstep -> packages/runner/crates/forge-runner-core/src/runner/claude_code.rs — this number and `SESSION_IDLE_TIMEOUT` are ONE value in two places, and `resolve_residency` there reads the same `sessionResidencySeconds` with the same rule: absent or 0 means this default, never zero residency. Diverge and core reaps a park the runner still considers live, at which point `residency_expired` stops meaning "the runner is gone".
const DEFAULT_RESIDENCY_SECONDS = 10 * 60;

// cm:guard a grace, not a tuning margin — it exists so the runner always closes its own park first and core only sees the ones it could not. Shrinking it toward zero makes the two sides race and the recorded failureReason stop meaning "the runner is gone".
const PARK_GRACE_SECONDS = 5 * 60;

// cm:guard `agent_sessions.project_id` written LITERALLY, and the column list of `projects` is read by name — drizzle renders a column reference inside a raw `sql` template unqualified, and an unqualified `project_id` here would resolve against `projects` first. A wrong JSON path does NOT fail: COALESCE swallows it and every project silently falls back to the default, which is why `park-deadline-e2e.test.ts` asserts a project that CONFIGURED a long residency is left alone.
const RESIDENCY_DEADLINE = sql`
  COALESCE(${agentSessions.lastHeartbeatAt}, ${agentSessions.createdAt})
    < now() - make_interval(secs => ${PARK_GRACE_SECONDS} + COALESCE((
        SELECT (p.agent_config -> 'pipelineConfig' ->> 'sessionResidencySeconds')::int
        FROM projects p WHERE p.id = agent_sessions.project_id
      ), ${DEFAULT_RESIDENCY_SECONDS}))`;

// cm:guard `blocker_kind = 'human'` is the whole discriminator and widening it to any open question is a BUG: `begin_question` is step one of BOTH arms of `runner/blocked.rs`, so a machine or master-or-peer park writes an open row too — and those keep their process, which is precisely the world residency's premise describes (ISS-964 criteria 5, 24).
// cm:guard `agent_sessions.id` and `agent_questions` columns written LITERALLY for the same reason the deadline above is: drizzle renders a column reference inside a raw `sql` template unqualified, and an unqualified `id` here resolves against `agent_questions` first, which matches nothing and silently exempts NOTHING.
const NOT_A_PROCESSLESS_PARK = sql`
  NOT EXISTS (
    SELECT 1 FROM agent_questions q
     WHERE q.agent_session_id = agent_sessions.id
       AND q.status = 'open'
       AND q.blocker_kind = 'human'
  )`;

/**
 * Hop 3b — the residency deadline. A session parked past its runner's ceiling
 * plus a grace: the runner is presumed gone, so close the row and free the slot.
 */
// cm:guard a reason of its own, never `heartbeat_timeout` — this session did not miss a heartbeat, it was exempt from that clock by design, and recording the wrong cause sends whoever reads it to the runner logs for a stall that is not there.
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

// cm:guard the count is days SINCE THE QUESTION WAS ASKED, floored at one — not the width of the deadline window. The person reading `unanswered_2d` needs to know how long their answer was owed, and a park asked and expired inside a day reads `1d` rather than the `0d` a bare floor would produce.
// cm:guard a NULL `park_deadline_at` is an UNBOUNDED wait and must never match: criterion 8 promises the human branch waits with no time limit, so reading NULL as expired would silently cap the one wait the design says has none.
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
// cm:guard the question flip is LAST and is the whole of the idempotency: the sweep stops matching a row it has expired, so no marker column and no park closed twice. Flipping it first would drop the park's record if the session transition then failed, leaving a terminal session nobody can trace to a question.
// cm:guard core does NOT release the worktree here, and adding that is the wrong repair: criterion 34 releases it only after the diff is preserved, and the preserve half is the runner's `Abandon`. Not releasing keeps the tree; releasing from here would drop a diff nothing has saved.
export async function reapUnansweredParks(
  now: Date = new Date(),
  scope: LoopScope = {},
): Promise<number> {
  const parks = await unansweredParks(now, scope);
  let closed = 0;

  for (const park of parks) {
    // cm:guard the SESSION carries one fixed cause and the QUESTION carries the duration, never the reverse: `failure_reason` is a closed taxonomy the metrics group by (`pipeline/failure-causes.ts`), so a per-row `unanswered_2d` there would land every park in `unclassified` and make the count unreadable. Its origin is `user`, which keeps a park nobody answered out of the real-failure rate.
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
