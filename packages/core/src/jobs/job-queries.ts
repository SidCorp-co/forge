/** Job reads: one place to load a job by id, whole or as the gates see it. */

import { eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { jobs } from '../db/schema.js';

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
