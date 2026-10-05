import { LIVE_JOB_STATUSES } from '@forge/contracts/job-machine';
import type { Tx } from '../db/client.js';
import { jobs } from '../db/schema.js';
import { assertRunAcceptsWork } from '../pipeline/index.js';

/**
 * The one insert into `jobs`, inside the caller's transaction. A unique violation on the active
 * job of an issue and type reaches the caller as the database raised it; a live row under a run
 * that no longer takes work is refused `RUN_NOT_ACCEPTING_WORK`.
 */
export async function insertJobRow(
  tx: Tx,
  values: typeof jobs.$inferInsert,
): Promise<{ id: string }> {
  if (LIVE_JOB_STATUSES.includes(values.status ?? 'queued')) {
    await assertRunAcceptsWork(tx, values.pipelineRunId);
  }
  const [row] = await tx.insert(jobs).values(values).returning({ id: jobs.id });
  if (!row) throw new Error('jobs: insert returned no row');
  return row;
}
