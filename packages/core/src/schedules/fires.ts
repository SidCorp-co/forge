// cm:why the one application writer of schedule_runs (design automation rev 1, steps tick, route,
// skipped, agent_runs and settle; ISS-112): every fire of every kind is opened here and a fire that
// ran no session is settled here once, each move through the kernel transition on the schedule-run
// machine. A schedule's last status is its newest fire's, read (`lastFireStatus`) and never stored.
// A fire that started a session settles when that session stops, whoever stops it, in the session
// move's own transaction (`agent-sessions/session-transition.ts:transitionSessions`); a session row
// deleted under a running fire is settled by trigger `forge_session_delete_settles_its_fire`.

import type {
  ScheduleRunSkipReason,
  ScheduleRunStatus,
  ScheduleRunTrigger,
} from '@forge/contracts/schedules';
import { SCHEDULE_RUN_MACHINE } from '@forge/contracts/schedule-run-machine';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { scheduleRuns, schedules } from '../db/schema.js';
import { type KernelActor, type KernelExecutor, transition } from '../lifecycle/transition.js';

export type FireSettlement =
  | { status: 'success'; output?: string | null; pipelineRunId?: string | null }
  | {
      status: 'skipped';
      reason: ScheduleRunSkipReason;
      refusal?: string | null;
      output?: string | null;
    }
  | { status: 'failed'; error: string; output?: string | null };

export interface FireSession {
  id: string;
  pipelineRunId: string;
}

/** A schedule's last status: the status of its newest fire, or null before its first. */
export const lastFireStatus = sql<ScheduleRunStatus | null>`(
  SELECT r.status FROM ${scheduleRuns} r
   WHERE r.schedule_id = ${schedules.id}
   ORDER BY r.created_at DESC
   LIMIT 1
)`;

export async function openFire(args: {
  scheduleId: string;
  projectId: string;
  trigger: ScheduleRunTrigger;
}): Promise<string> {
  const startedAt = new Date();
  return db.transaction(async (tx) => {
    const [fire] = await tx
      .insert(scheduleRuns)
      .values({
        scheduleId: args.scheduleId,
        projectId: args.projectId,
        trigger: args.trigger,
        status: 'running',
        startedAt,
      })
      .returning({ id: scheduleRuns.id });
    if (!fire) {
      throw new Error(
        `schedule_runs: opening a fire of schedule ${args.scheduleId} returned no row`,
      );
    }
    await tx
      .update(schedules)
      .set({ lastRunAt: startedAt })
      .where(eq(schedules.id, args.scheduleId));
    return fire.id;
  });
}

export async function attachFireSession(fireId: string, session: FireSession): Promise<void> {
  await db
    .update(scheduleRuns)
    .set({ sessionId: session.id, pipelineRunId: session.pipelineRunId })
    .where(eq(scheduleRuns.id, fireId));
}

// cm:guard a fire settles once: the write matches only a fire still running and holding no
// session, so it never overrides the end the fire's own session records.
export async function settleFire(fireId: string, settlement: FireSettlement): Promise<boolean> {
  const set: Partial<typeof scheduleRuns.$inferInsert> = {
    finishedAt: new Date(),
    reason: settlement.status === 'skipped' ? settlement.reason : null,
    refusal: settlement.status === 'skipped' ? (settlement.refusal ?? null) : null,
    error: settlement.status === 'failed' ? settlement.error : null,
  };
  if (settlement.output !== undefined) set.output = settlement.output;
  if (settlement.status === 'success' && settlement.pipelineRunId) {
    set.pipelineRunId = settlement.pipelineRunId;
  }
  const { rows } = await transition(db, SCHEDULE_RUN_MACHINE, {
    to: settlement.status,
    from: 'running',
    set,
    where: and(eq(scheduleRuns.id, fireId), sql`${scheduleRuns.sessionId} IS NULL`),
    reason: settlement.status === 'skipped' ? settlement.reason : null,
    actor: { type: 'system' },
    source: 'schedule-fire',
    returning: ['id'],
  });
  return rows.length > 0;
}

export function scheduleRunIdOf(metadata: unknown): string | null {
  const meta = (metadata ?? {}) as Record<string, unknown>;
  return typeof meta.scheduleRunId === 'string' ? meta.scheduleRunId : null;
}

export async function handFireToRetry(args: {
  failedSessionId: string;
  retry: FireSession;
  disposition: string;
}): Promise<boolean> {
  const { rows } = await transition(db, SCHEDULE_RUN_MACHINE, {
    to: 'running',
    from: 'failed',
    set: {
      sessionId: args.retry.id,
      pipelineRunId: args.retry.pipelineRunId,
      finishedAt: null,
      error: null,
      refusal: null,
      disposition: args.disposition,
    },
    where: eq(scheduleRuns.sessionId, args.failedSessionId),
    reason: args.disposition,
    actor: { type: 'system' },
    source: 'schedule-fire-retry',
    returning: ['id'],
  });
  return rows.length > 0;
}

export async function recordFireDisposition(args: {
  failedSessionId: string;
  disposition: string;
}): Promise<boolean> {
  const rows = await db
    .update(scheduleRuns)
    .set({ disposition: args.disposition })
    .where(eq(scheduleRuns.sessionId, args.failedSessionId))
    .returning({ id: scheduleRuns.id });
  return rows.length > 0;
}

/** The fires these sessions started, settled as their sessions ended: `success` for a completion,
 *  `failed` with the session's failure for anything else. */
export async function settleSessionFires(
  exec: KernelExecutor,
  args: { sessionIds: readonly string[]; sessionStatus: string; actor: KernelActor; source: string },
): Promise<void> {
  if (args.sessionIds.length === 0) return;
  const succeeded =
    args.sessionStatus === 'completed' || args.sessionStatus === 'completed_via_recovery';
  await transition(exec, SCHEDULE_RUN_MACHINE, {
    to: succeeded ? 'success' : 'failed',
    from: 'running',
    where: inArray(scheduleRuns.sessionId, [...args.sessionIds]),
    set: {
      finishedAt: new Date(),
      error: succeeded
        ? null
        : sql`(SELECT coalesce(a.failure_reason, 'session ' || a.status) || coalesce(': ' || a.failure_detail, '') FROM agent_sessions a WHERE a.id = ${scheduleRuns.sessionId})`,
      refusal: succeeded
        ? null
        : sql`(SELECT CASE WHEN a.failure_reason = 'session_authority_refused' AND split_part(a.failure_detail, ':', 1) ~ '^[A-Z][A-Z0-9_]*$' THEN split_part(a.failure_detail, ':', 1) END FROM agent_sessions a WHERE a.id = ${scheduleRuns.sessionId})`,
    } as never,
    returning: ['id'],
    reason: `its session ended ${args.sessionStatus}`,
    actor: args.actor,
    source: args.source,
  });
}
