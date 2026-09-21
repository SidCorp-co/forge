/**
 * Job reads both transports share.
 *
 * The one-line "load a job by id" had ten copies across this domain; a
 * transport needs no handle of its own to do it. The list projection is here
 * for a stronger reason — see its guard.
 */

import { and, asc, desc, eq, gt, type SQL } from 'drizzle-orm';
import { db } from '../db/client.js';
import { type JobStatus, type JobType, jobEvents, jobs } from '../db/schema.js';

/** One job, whole, or `null`. Authorisation belongs to the caller. */
export async function readJob(jobId: string) {
  const [row] = await db.select().from(jobs).where(eq(jobs.id, jobId)).limit(1);
  return row ?? null;
}

const jobGateColumns = {
  id: jobs.id,
  projectId: jobs.projectId,
  deviceId: jobs.deviceId,
  status: jobs.status,
  agentSessionId: jobs.agentSessionId,
  ackedAt: jobs.ackedAt,
  error: jobs.error,
  killRequestedAt: jobs.killRequestedAt,
} as const;

/** The shape every device/lifecycle gate handler works from. */
export type JobGateRow = {
  [K in keyof typeof jobGateColumns]: (typeof jobs.$inferSelect)[K];
};

/**
 * One job as the ingest and lifecycle GATES see it — the eight scalar columns
 * those handlers actually read, never the prompt or failure payloads.
 *
 * Authorisation belongs to the caller, as with {@link readJob}.
 */
export async function readJobGate(jobId: string): Promise<JobGateRow | null> {
  const [row] = await db.select(jobGateColumns).from(jobs).where(eq(jobs.id, jobId)).limit(1);
  return row ?? null;
}

export type JobQuery = {
  projectId: string;
  status?: JobStatus | undefined;
  type?: JobType | undefined;
  issueId?: string | undefined;
  limit: number;
};

export async function listJobs(q: JobQuery) {
  const conds: SQL[] = [eq(jobs.projectId, q.projectId)];
  if (q.status) conds.push(eq(jobs.status, q.status));
  if (q.type) conds.push(eq(jobs.type, q.type));
  if (q.issueId) conds.push(eq(jobs.issueId, q.issueId));

  return db
    .select({
      id: jobs.id,
      projectId: jobs.projectId,
      issueId: jobs.issueId,
      pipelineRunId: jobs.pipelineRunId,
      deviceId: jobs.deviceId,
      runnerId: jobs.runnerId,
      createdBy: jobs.createdBy,
      type: jobs.type,
      status: jobs.status,
      queuedAt: jobs.queuedAt,
      dispatchedAt: jobs.dispatchedAt,
      ackedAt: jobs.ackedAt,
      finishedAt: jobs.finishedAt,
      exitCode: jobs.exitCode,
      modelTier: jobs.modelTier,
      attempts: jobs.attempts,
      cancellationRequested: jobs.cancellationRequested,
      retryOf: jobs.retryOf,
      retryAfterAt: jobs.retryAfterAt,
      agentSessionId: jobs.agentSessionId,
      failureKind: jobs.failureKind,
      failureAction: jobs.failureAction,
      failureReason: jobs.failureReason,
      classifierVersion: jobs.classifierVersion,
      systemPromptHash: jobs.systemPromptHash,
      promptInputTokenEst: jobs.promptInputTokenEst,
      modelUsed: jobs.modelUsed,
      archivePath: jobs.archivePath,
      createdAt: jobs.createdAt,
    })
    .from(jobs)
    .where(and(...conds))
    .orderBy(desc(jobs.queuedAt))
    .limit(q.limit);
}

/** A job's event stream from `sinceSeq` forward, oldest first. */
export async function listJobEvents(jobId: string, limit: number, sinceSeq?: number) {
  const conds: SQL[] = [eq(jobEvents.jobId, jobId)];
  if (sinceSeq !== undefined) conds.push(gt(jobEvents.seq, sinceSeq));

  return db
    .select()
    .from(jobEvents)
    .where(and(...conds))
    .orderBy(asc(jobEvents.seq))
    .limit(limit);
}
