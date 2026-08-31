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

export type JobQuery = {
  projectId: string;
  status?: JobStatus | undefined;
  type?: JobType | undefined;
  issueId?: string | undefined;
  limit: number;
};

// cm:guard NEVER widen this to `select()` (ISS-478, sibling of ISS-428). The `payload` / `promptBlocks` / `failureMeta` jsonb and the unbounded `userPromptSnapshot` / `error` text overflow the MCP token cap — 862K characters observed live — and an overflowing MCP result does not truncate, it crashes the agent mid-turn. `readJob` is where a caller that needs those goes.
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
