import { LIVE_PIPELINE_RUN_STATUSES } from '@forge/contracts/run-machine';
import { sql } from 'drizzle-orm';
import type { Tx } from '../db/client.js';
import { refusePipeline } from './refuse.js';

const ACCEPTING: ReadonlySet<string> = new Set(LIVE_PIPELINE_RUN_STATUSES);

/**
 * The one kernel guard for a write that puts a job or a session INTO an active status: inside the
 * caller's transaction, the parent run is read `FOR SHARE` (so it cannot close under the write)
 * and anything but `running` or `paused` is refused by name. A child with no run, or a run that
 * does not exist, is not this guard's to judge (the I1 trigger lets both through too).
 */
export async function assertRunAcceptsWork(
  tx: Tx,
  runId: string | null | undefined,
): Promise<void> {
  if (!runId) return;
  const rows = (await tx.execute(
    sql`SELECT status FROM pipeline_runs WHERE id = ${runId} FOR SHARE`,
  )) as unknown as Array<{ status: string }>;
  const status = rows[0]?.status;
  if (status === undefined || ACCEPTING.has(status)) return;
  throw refusePipeline(
    'RUN_NOT_ACCEPTING_WORK',
    `pipeline run ${runId} is ${status}, so it takes no active job or session: the work it held is over`,
  );
}
