// The one application writer of schedule_runs (design automation, steps tick, route, skipped,
// agent_runs and settle): every fire of every kind is opened here and a fire that ran no session is
// settled here once, each move through the kernel transition on the schedule-run machine. A fire
// that started a session settles when that session stops, whoever stops it, in the session move's
// own transaction (`agent-sessions/session-transition.ts:transitionSessions`); a session row deleted
// under a running fire is settled by trigger `forge_session_delete_settles_its_fire`. Nothing is
// copied onto the schedule; its last status is its newest fire (`lastFires`).

import { SCHEDULE_RUN_MACHINE } from '@forge/contracts/schedule-run-machine';
import type {
  ScheduleRunSkipReason,
  ScheduleRunStatus,
  ScheduleRunTrigger,
} from '@forge/contracts/schedules';
import type { ScriptRead } from '@forge/contracts/script-sandbox';
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { scheduleRuns } from '../db/schema.js';
import { type KernelActor, type KernelExecutor, transition } from '../lifecycle/index.js';

/** A script fire's record (REQ-37 BC-9): who it read Forge as, and every read with its status. */
interface ScriptFireRecord {
  runAs?: string | null;
  reads?: ScriptRead[];
}

export type FireSettlement =
  | ({
      status: 'success';
      output?: string | null;
      pipelineRunId?: string | null;
    } & ScriptFireRecord)
  | {
      status: 'skipped';
      reason: ScheduleRunSkipReason;
      refusal?: string | null;
      output?: string | null;
    }
  | ({ status: 'failed'; error: string; output?: string | null } & ScriptFireRecord);

interface FireSession {
  id: string;
  pipelineRunId: string;
}

export async function openFire(args: {
  scheduleId: string;
  projectId: string;
  trigger: ScheduleRunTrigger;
}): Promise<string> {
  const [fire] = await db
    .insert(scheduleRuns)
    .values({
      scheduleId: args.scheduleId,
      projectId: args.projectId,
      trigger: args.trigger,
      status: 'running',
      startedAt: new Date(),
    })
    .returning({ id: scheduleRuns.id });
  if (!fire) {
    throw new Error(`schedule_runs: opening a fire of schedule ${args.scheduleId} returned no row`);
  }
  return fire.id;
}

export async function attachFireSession(fireId: string, session: FireSession): Promise<void> {
  await db
    .update(scheduleRuns)
    .set({ sessionId: session.id, pipelineRunId: session.pipelineRunId })
    .where(eq(scheduleRuns.id, fireId));
}

// a fire settles once: the write matches only a fire still running and holding no
// session, so it never overrides the end the fire's own session records.
export async function settleFire(fireId: string, settlement: FireSettlement): Promise<boolean> {
  const set: Partial<typeof scheduleRuns.$inferInsert> = {
    finishedAt: new Date(),
    reason: settlement.status === 'skipped' ? settlement.reason : null,
    refusal: settlement.status === 'skipped' ? (settlement.refusal ?? null) : null,
    error: settlement.status === 'failed' ? settlement.error : null,
  };
  if (settlement.output !== undefined) set.output = settlement.output;
  if (settlement.status !== 'skipped' && settlement.reads !== undefined) {
    set.runAs = settlement.runAs ?? null;
    set.reads = settlement.reads;
  }
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

export interface LastFire {
  id: string;
  status: ScheduleRunStatus;
  trigger: ScheduleRunTrigger;
  startedAt: Date;
  finishedAt: Date | null;
  reason: ScheduleRunSkipReason | null;
  refusal: string | null;
  sessionId: string | null;
}

/** Each schedule's newest fire, by schedule id: what a schedule's last status, run and session are. */
export async function lastFires(
  projectId: string,
  scheduleIds?: readonly string[],
): Promise<Map<string, LastFire>> {
  const where = [eq(scheduleRuns.projectId, projectId)];
  if (scheduleIds) {
    if (scheduleIds.length === 0) return new Map();
    where.push(inArray(scheduleRuns.scheduleId, [...scheduleIds]));
  }
  const rows = await db
    .selectDistinctOn([scheduleRuns.scheduleId], {
      scheduleId: scheduleRuns.scheduleId,
      id: scheduleRuns.id,
      status: scheduleRuns.status,
      trigger: scheduleRuns.trigger,
      startedAt: scheduleRuns.startedAt,
      finishedAt: scheduleRuns.finishedAt,
      reason: scheduleRuns.reason,
      refusal: scheduleRuns.refusal,
      sessionId: scheduleRuns.sessionId,
    })
    .from(scheduleRuns)
    .where(and(...where))
    .orderBy(scheduleRuns.scheduleId, desc(scheduleRuns.createdAt), desc(scheduleRuns.id));
  return new Map(rows.map(({ scheduleId, ...f }) => [scheduleId, f]));
}

/**
 * The fires whose schedule kind owes a record, matched where that record is missing (ISS-814): a
 * `cleanup` fire's session owes a cleanup report naming the fire (REQ-79 BC-9). A session that ends
 * its turn without posting it — waiting on a notification nothing delivers — completes, and the fire
 * would read `success` with no report behind it (`VISION: state-never-lies`). Every other kind owes
 * nothing a completed session has to leave.
 */
const RECORD_MISSING = sql`EXISTS (
  SELECT 1 FROM schedules s
   WHERE s.id = ${scheduleRuns.scheduleId}
     AND s.kind = 'cleanup'
     AND NOT EXISTS (SELECT 1 FROM cleanup_reports c WHERE c.schedule_run_id = ${scheduleRuns.id}))`;

const ENDED_WITHOUT_REPORT = sql`'ended without a report: the cleanup session completed, and no cleanup report names fire ' || ${scheduleRuns.id}::text || '. The run posts one, red or green, with ' || chr(96) || 'fire' || chr(96) || ' set (POST /api/projects/:id/cleanup-reports) before its turn ends'`;

/** The fires these sessions started, settled as their sessions ended: `success` for a completion,
 *  `failed` with the session's failure for anything else. A completion that leaves the record its
 *  fire's kind owes is `failed` too, naming the missing record (`RECORD_MISSING`). */
export async function settleSessionFires(
  exec: KernelExecutor,
  args: {
    sessionIds: readonly string[];
    sessionStatus: string;
    actor: KernelActor;
    source: string;
  },
): Promise<void> {
  if (args.sessionIds.length === 0) return;
  const ofSessions = inArray(scheduleRuns.sessionId, [...args.sessionIds]);
  const succeeded =
    args.sessionStatus === 'completed' || args.sessionStatus === 'completed_via_recovery';
  if (succeeded) {
    await transition(exec, SCHEDULE_RUN_MACHINE, {
      to: 'failed',
      from: 'running',
      where: and(ofSessions, RECORD_MISSING),
      set: { finishedAt: new Date(), error: ENDED_WITHOUT_REPORT, refusal: null } as never,
      returning: ['id'],
      reason: `its session ended ${args.sessionStatus} without the report its fire owes`,
      actor: args.actor,
      source: args.source,
    });
  }
  await transition(exec, SCHEDULE_RUN_MACHINE, {
    to: succeeded ? 'success' : 'failed',
    from: 'running',
    where: ofSessions,
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

/** The project a fire belongs to, or null where no fire has this id. */
export async function fireProjectOf(fireId: string): Promise<string | null> {
  const [row] = await db
    .select({ projectId: scheduleRuns.projectId })
    .from(scheduleRuns)
    .where(eq(scheduleRuns.id, fireId))
    .limit(1);
  return row?.projectId ?? null;
}
