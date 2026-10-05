import { JOB_MACHINE, type JobStatus, OCCUPYING_JOB_STATUSES } from '@forge/contracts/job-machine';
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import { beatSession, transitionSessions } from '../agent-sessions/index.js';
import { db, type Tx } from '../db/client.js';
import { agentSessions, jobEvents, jobs, skills } from '../db/schema.js';
import { lockXact } from '../lib/advisory-lock.js';
import { transition } from '../lifecycle/index.js';
import type { JobGateRow } from './job-queries.js';
import { jobsPorts } from './ports.js';

/** A job created by REST, queued on the given run; answers the whole row. */
export async function createQueuedJob(
  values: Omit<typeof jobs.$inferInsert, 'status'>,
): Promise<typeof jobs.$inferSelect> {
  const [inserted] = await db
    .insert(jobs)
    .values({ ...values, status: 'queued' })
    .returning();
  if (!inserted) throw new Error('jobs: insert returned no row');
  return inserted;
}

/** A queued job's payload or model tier, replaced; answers the row, or null when it is gone. */
export async function patchJob(
  jobId: string,
  values: Pick<Partial<typeof jobs.$inferInsert>, 'payload' | 'modelTier'>,
): Promise<typeof jobs.$inferSelect | null> {
  const [updated] = await db.update(jobs).set(values).where(eq(jobs.id, jobId)).returning();
  return updated ?? null;
}

/**
 * The runner's ACK: stamps `ackedAt` once on an occupying job, records the skills it ran with,
 * and answers the stamped row, or null when another ack, a terminal status or the event
 * fallback got there first.
 */
export async function ackJob(
  job: JobGateRow,
  deviceId: string,
  skillsRanWith: Record<string, string> | null,
  now: Date,
): Promise<{ id: string; status: JobStatus; ackedAt: Date | null } | null> {
  const skillLookups =
    skillsRanWith && Object.keys(skillsRanWith).length > 0
      ? await Promise.all(
          Object.entries(skillsRanWith).map(async ([name, hash]) => {
            const [skill] = await db
              .select({ id: skills.id })
              .from(skills)
              .where(
                and(
                  eq(skills.scope, 'project'),
                  eq(skills.projectId, job.projectId),
                  eq(skills.name, name),
                ),
              )
              .limit(1);
            return { name, hash, skillId: skill?.id };
          }),
        )
      : [];
  const updated = await db.transaction(async (tx) => {
    const [row] = await tx
      .update(jobs)
      .set({
        ackedAt: now,
        killRequestedAt: null,
        killConfirmedAt: null,
        killOutcome: null,
        ...(skillsRanWith !== null ? { skillsRanWith } : {}),
      })
      .where(
        and(
          eq(jobs.id, job.id),
          isNull(jobs.ackedAt),
          inArray(jobs.status, [...OCCUPYING_JOB_STATUSES]),
        ),
      )
      .returning({ id: jobs.id, status: jobs.status, ackedAt: jobs.ackedAt });
    if (row) {
      for (const lookup of skillLookups) {
        await jobsPorts().skillActivity.recordSkillActivityEvent(tx, {
          eventType: 'job.ran.with',
          actor: `runner:${deviceId}`,
          trigger: 'push',
          projectId: job.projectId,
          deviceId,
          ...(lookup.skillId ? { skillId: lookup.skillId } : {}),
          afterHash: lookup.hash,
          reason: `jobId=${job.id}`,
          deltaSummary: lookup.name,
          outcome: 'ok',
        });
      }
    }
    return row;
  });
  return updated ?? null;
}

/**
 * A late successful completion of a job a sweep reaped to `failed` with a synthetic error:
 * flipped back to `done` unless a retry attempt is queued, dispatched or done. Answers the
 * reclaimed row, or null when a retry owns the outcome or the row moved.
 */
export async function reclaimReapedJob(job: JobGateRow & { error: string }, deviceId: string) {
  const activeRetry = await db
    .select({ id: jobs.id })
    .from(jobs)
    .where(and(eq(jobs.retryOf, job.id), inArray(jobs.status, ['queued', 'dispatched', 'done'])))
    .limit(1);
  if (activeRetry.length > 0) return null;
  const [reclaimed] = (
    await transition(db, JOB_MACHINE, {
      to: 'done',
      set: { exitCode: 0, error: null, finishedAt: new Date() },
      where: and(eq(jobs.id, job.id), eq(jobs.status, 'failed'), eq(jobs.error, job.error)),
      reason: 'reconciled_late_complete',
      actor: { type: 'runner', id: deviceId },
      source: 'lifecycle',
    })
  ).rows;
  return reclaimed ?? null;
}

/** A runner's terminal report applied to the job it holds, guarded on the status it read. */
export async function finishJobFromRunner(args: {
  jobId: string;
  from: JobStatus;
  to: 'done' | 'cancelled' | 'failed';
  set: Partial<typeof jobs.$inferInsert>;
  reason: string;
  deviceId: string;
}) {
  const [updated] = (
    await transition(db, JOB_MACHINE, {
      to: args.to,
      set: args.set,
      where: and(eq(jobs.id, args.jobId), eq(jobs.status, args.from)),
      reason: args.reason,
      actor: { type: 'runner', id: args.deviceId },
      source: 'lifecycle',
    })
  ).rows;
  return updated;
}

/** The next server-assigned job_events seq, under the job's advisory lock. */
async function lockNextEventSeq(tx: Tx, jobId: string): Promise<number> {
  await lockXact(tx, 'job', jobId);
  const maxRows = await tx.execute<{ max_seq: number | string | null }>(
    sql`SELECT COALESCE(MAX(seq), 0) AS max_seq FROM job_events WHERE job_id = ${jobId}`,
  );
  const first = maxRows[0] as { max_seq: number | string | null } | undefined;
  return Number(first?.max_seq ?? 0) + 1;
}

/**
 * The runner's kill-ack: stamps `killConfirmedAt` / `killOutcome` (first ack wins) when a kill
 * was requested, and always appends the audited `kill_ack` event.
 */
export async function confirmJobKill(
  jobId: string,
  outcome: 'killed' | 'not_found',
  deviceId: string,
  recorded: boolean,
): Promise<void> {
  const now = new Date();
  await db.transaction(async (tx) => {
    if (recorded) {
      await tx
        .update(jobs)
        .set({ killConfirmedAt: now, killOutcome: outcome })
        .where(and(eq(jobs.id, jobId), isNull(jobs.killConfirmedAt)));
    }
    const seq = await lockNextEventSeq(tx, jobId);
    await tx.insert(jobEvents).values({
      jobId,
      kind: 'kill_ack',
      data: { outcome, deviceId, recorded },
      seq,
    });
  });
}

/** A batch of device-posted events appended in order with server-assigned seqs. */
export async function appendJobEvents(
  jobId: string,
  events: readonly {
    kind: (typeof jobEvents.$inferInsert)['kind'];
    data: (typeof jobEvents.$inferInsert)['data'];
    ts?: string | undefined;
  }[],
): Promise<(typeof jobEvents.$inferSelect)[]> {
  if (events.length === 0) return [];
  return db.transaction(async (tx) => {
    const baseSeq = (await lockNextEventSeq(tx, jobId)) - 1;
    const values = events.map((e, i) => ({
      jobId,
      kind: e.kind,
      data: e.data,
      seq: baseSeq + i + 1,
      ...(e.ts ? { ts: new Date(e.ts) } : {}),
    }));
    return tx.insert(jobEvents).values(values).returning();
  });
}

/** The first event batch doubles as the ACK for runners that never call /ack. */
export async function stampJobAckFromEvents(jobId: string): Promise<void> {
  await db
    .update(jobs)
    .set({
      ackedAt: new Date(),
      killRequestedAt: null,
      killConfirmedAt: null,
      killOutcome: null,
    })
    .where(and(eq(jobs.id, jobId), isNull(jobs.ackedAt)));
}

/**
 * The linked session's heartbeat; when the batch shows a turn ran, its queued -> running
 * transition too. Answers the started session, or null when nothing started.
 */
export async function beatLinkedSession(
  agentSessionId: string,
  at: Date,
  sawTurn: boolean,
  deviceId: string,
): Promise<{ id: string; projectId: string; deviceId: string | null } | null> {
  return db.transaction(async (tx) => {
    const beat = await beatSession(agentSessionId, { at, liveOnly: true }, tx);
    if (!sawTurn || !beat) return null;
    const [row] = (
      await transitionSessions(tx, {
        to: 'running',
        from: 'queued',
        set: { startedAt: at },
        where: eq(agentSessions.id, agentSessionId),
        actor: { type: 'runner', id: deviceId },
        source: 'job-events',
        returning: ['id', 'projectId', 'deviceId'],
      })
    ).rows;
    return row ?? null;
  });
}
