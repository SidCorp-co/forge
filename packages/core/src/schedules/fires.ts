// The one application writer of schedule_runs (design automation, steps tick, route, skipped,
// agent_runs and settle): every fire of every kind is opened here and a fire that ran no session is
// settled here once. A fire that started a session settles when that session stops, whoever stops
// it: trigger `forge_session_stop_settles_its_fire`. Nothing is copied onto the schedule; its last
// status is its newest fire (`lastFires`).

import type {
  ScheduleRunSkipReason,
  ScheduleRunStatus,
  ScheduleRunTrigger,
} from '@forge/contracts/schedules';
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { scheduleRuns } from '../db/schema.js';

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

// cm:guard a fire settles once: the write matches only a fire still running and holding no
// session, so it never overrides the end the fire's own session records.
export async function settleFire(fireId: string, settlement: FireSettlement): Promise<boolean> {
  const set: Partial<typeof scheduleRuns.$inferInsert> = {
    status: settlement.status,
    finishedAt: new Date(),
    reason: settlement.status === 'skipped' ? settlement.reason : null,
    refusal: settlement.status === 'skipped' ? (settlement.refusal ?? null) : null,
    error: settlement.status === 'failed' ? settlement.error : null,
  };
  if (settlement.output !== undefined) set.output = settlement.output;
  if (settlement.status === 'success' && settlement.pipelineRunId) {
    set.pipelineRunId = settlement.pipelineRunId;
  }
  const settled = await db
    .update(scheduleRuns)
    .set(set)
    .where(
      and(
        eq(scheduleRuns.id, fireId),
        eq(scheduleRuns.status, 'running'),
        sql`${scheduleRuns.sessionId} IS NULL`,
      ),
    )
    .returning({ id: scheduleRuns.id });
  return settled.length > 0;
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
  const handed = await db
    .update(scheduleRuns)
    .set({
      sessionId: args.retry.id,
      pipelineRunId: args.retry.pipelineRunId,
      status: 'running',
      finishedAt: null,
      error: null,
      refusal: null,
      disposition: args.disposition,
    })
    .where(eq(scheduleRuns.sessionId, args.failedSessionId))
    .returning({ id: scheduleRuns.id });
  return handed.length > 0;
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
