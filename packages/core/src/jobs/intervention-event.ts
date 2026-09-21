import { sql } from 'drizzle-orm';
import type { db } from '../db/client.js';
import { jobEvents } from '../db/schema.js';

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/** What the operator did. Widen this, never the `kind` — see the edge below. */
export type InterventionAction = 'cancel' | 'resume' | 'answer' | 'inject';

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
 * Append the intervention row inside an OPEN transaction, so the status
 * mutation and its audit trail commit together or not at all.
 */
export async function insertInterventionEvent(
  tx: Tx,
  input: InterventionEventInput,
): Promise<void> {
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${input.jobId}))`);
  const maxRows = await tx.execute<{ max_seq: number | string | null }>(
    sql`SELECT COALESCE(MAX(seq), 0) AS max_seq FROM job_events WHERE job_id = ${input.jobId}`,
  );
  const first = maxRows[0] as { max_seq: number | string | null } | undefined;
  const nextSeq = Number(first?.max_seq ?? 0) + 1;

  await tx.insert(jobEvents).values({
    jobId: input.jobId,
    kind: 'intervention',
    data: {
      action: input.action,
      actor: input.actorUserId,
      reason: input.reason,
      source: input.source,
      previousStatus: input.previousStatus,
      issueId: input.issueId,
    },
    seq: nextSeq,
  });
}
