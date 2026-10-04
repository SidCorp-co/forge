// cm:why the one application writer of schedule_runs (design automation rev 1, steps tick, route,
// skipped, agent_runs and settle; ISS-112): every fire of every kind is opened here, a fire that ran
// no session is settled here once, and schedules.last_status is written from the fire, never beside
// it. A fire that started a session settles when that session stops, whoever stops it: trigger
// `forge_session_stop_settles_its_fire` (migration 0367).

import type {
  ScheduleRunSkipReason,
  ScheduleRunStatus,
  ScheduleRunTrigger,
} from '@forge/contracts/schedules';
import { and, eq, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { scheduleRuns, schedules } from '../db/schema.js';

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

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

// cm:guard only the schedule's newest fire writes schedules.last_status, so a late settle of an
// older fire never overwrites the status of one that started after it.
async function writeLastStatusFromFire(
  tx: Tx,
  fire: { id: string; scheduleId: string },
  status: ScheduleRunStatus,
): Promise<void> {
  await tx
    .update(schedules)
    .set({ lastStatus: status })
    .where(
      and(
        eq(schedules.id, fire.scheduleId),
        sql`NOT EXISTS (
          SELECT 1 FROM ${scheduleRuns} newer, ${scheduleRuns} this_fire
          WHERE this_fire.id = ${fire.id}
            AND newer.schedule_id = this_fire.schedule_id
            AND newer.created_at > this_fire.created_at
        )`,
      ),
    );
}

const SETTLED_FIRE = { id: scheduleRuns.id, scheduleId: scheduleRuns.scheduleId };

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
      .set({ lastStatus: 'running', lastRunAt: startedAt })
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
  return db.transaction(async (tx) => {
    const [fire] = await tx
      .update(scheduleRuns)
      .set(set)
      .where(
        and(
          eq(scheduleRuns.id, fireId),
          eq(scheduleRuns.status, 'running'),
          sql`${scheduleRuns.sessionId} IS NULL`,
        ),
      )
      .returning(SETTLED_FIRE);
    if (!fire) return false;
    await writeLastStatusFromFire(tx, fire, settlement.status);
    return true;
  });
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
  return db.transaction(async (tx) => {
    const [fire] = await tx
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
      .returning(SETTLED_FIRE);
    if (!fire) return false;
    await writeLastStatusFromFire(tx, fire, 'running');
    return true;
  });
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
