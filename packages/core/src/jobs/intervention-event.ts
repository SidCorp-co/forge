import { sql } from 'drizzle-orm';
import type { db } from '../db/client.js';
import { jobEvents } from '../db/schema.js';
import { lockXact } from '../lib/advisory-lock.js';

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/** What the operator did. Widen this, never the `kind` — see the edge below. */
type InterventionAction = 'cancel' | 'resume' | 'answer' | 'inject';

export interface InterventionEventInput {
  jobId: string;
  issueId: string | null;
  action: InterventionAction;
  actorUserId: string;
  reason: string;
  source: 'rest' | 'mcp';
  previousStatus: string;
}

/**
 * Append one event to a job's history inside an OPEN transaction, numbered next under the job's
 * lock, so the act it records and the row commit together or not at all.
 */
export async function appendJobEvent(
  tx: Tx,
  jobId: string,
  kind: (typeof jobEvents.$inferInsert)['kind'],
  data: Record<string, unknown>,
): Promise<void> {
  await lockXact(tx, 'job', jobId);
  const maxRows = await tx.execute<{ max_seq: number | string | null }>(
    sql`SELECT COALESCE(MAX(seq), 0) AS max_seq FROM job_events WHERE job_id = ${jobId}`,
  );
  const first = maxRows[0] as { max_seq: number | string | null } | undefined;
  await tx.insert(jobEvents).values({ jobId, kind, data, seq: Number(first?.max_seq ?? 0) + 1 });
}

/** The operator's intervention, appended in the transaction that made it. */
export async function insertInterventionEvent(
  tx: Tx,
  input: InterventionEventInput,
): Promise<void> {
  await appendJobEvent(tx, input.jobId, 'intervention', {
    action: input.action,
    actor: input.actorUserId,
    reason: input.reason,
    source: input.source,
    previousStatus: input.previousStatus,
    issueId: input.issueId,
  });
}
