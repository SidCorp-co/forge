/**
 * The audited `job_events` row every manual job intervention writes (ISS-442 C6).
 *
 * One writer, because the `seq` frontier is not a detail: it is an advisory lock
 * plus `MAX(seq)+1`, and two copies of that under concurrent inserts is a
 * duplicate-key wait for whichever surface was written second.
 */

import { sql } from 'drizzle-orm';
import type { db } from '../db/client.js';
import { jobEvents } from '../db/schema.js';

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/** What the operator did. Widen this, never the `kind` — see the edge below. */
export type InterventionAction = 'cancel' | 'resume';

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
// cm:edge contract -> packages/core/drizzle/migrations/0181_intervention_action_source.sql — `issue_intervention_events.source` is built as `'manual_' || data->>'action'`, so a new action value appears in the interventions metric under a name only this type decides. Adding one here without checking that view is how a resume came to be charted as a cancel.
// cm:guard the advisory lock must be taken on the JOB, not the event — it serialises the `MAX(seq)+1` read against a concurrent insert for the same job, and it auto-releases at COMMIT/ROLLBACK. Locking anything else lets two surfaces compute the same seq.
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
