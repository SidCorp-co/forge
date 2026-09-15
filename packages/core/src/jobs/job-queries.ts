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

// cm:guard the EXACT set the device and lifecycle gates read, and it is a closed list on purpose: a handler that needs a column absent here fails at the type, by name, which is the whole point. Do not widen it back to `select()`, do not add a column "while we are here", and never fall back to `readJob` for one missing field — the caller that needs the wide row is a caller that belongs on the wide door.
// cm:why `error` is in the narrow set although it is unbounded text: `POST /:id/complete` reads it to recognise a synthetic reap marker and re-states it in the CAS predicate, and on the hot path — a running job — the column is NULL. The columns this shape exists to leave behind are the `payload` / `promptBlocks` / `failureMeta` jsonb and `userPromptSnapshot`, which a running job always carries.
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

// cm:guard NEVER widen this to `select()` (ISS-478, sibling of ISS-428). The `payload` / `promptBlocks` / `failureMeta` jsonb and the unbounded `userPromptSnapshot` / `error` text overflow the MCP token cap — 862K characters observed live — and an overflowing MCP result does not truncate, it crashes the agent mid-turn.
// cm:guard there are TWO single-row doors above and they are not interchangeable (ISS-1014): `readJob` is the WIDE one and the only one that answers with `payload` / `promptBlocks` / `failureMeta` / `userPromptSnapshot` — the prompt endpoint (`jobs/routes.ts`) and the four MCP job tools go through it. `readJobGate` is the NARROW one, eight scalar columns, and it is what the per-event and per-lifecycle-call gates read on the hot path. Sending a gate to the wide door puts the unbounded prompt snapshot of every running job on a path that runs about twice a second per job.
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
