// The abort stamp on a release run (`pipeline_runs.metadata.abort`), and the one predicate every
// finish-side check reads. An abort cannot cancel before it recovers the roster — the run-close
// hook in `claim-subscriber.ts` would race it — so it writes this stamp first, and a batch is
// aborted to a finish from that write on.

import { sql } from 'drizzle-orm';
import { db, type Tx } from '../db/client.js';
import { pipelineRuns } from '../db/schema.js';
import { type AbortAccount, ReleaseBatchAbortedError } from './errors.js';
import { runRecordedPromotion } from './releasing-recovery.js';

export interface AbortStamp {
  at: string;
  reason: string;
  by: string;
  /** `returning` until the recovery has put the roster back and released its claims. */
  roster: 'held' | 'returning' | 'released';
}

export function readAbortStamp(metadata: unknown): AbortStamp | null {
  const raw = (metadata as { abort?: unknown } | null)?.abort;
  if (typeof raw !== 'object' || raw === null) return null;
  const r = raw as Record<string, unknown>;
  if (r.roster !== 'held' && r.roster !== 'returning' && r.roster !== 'released') return null;
  return {
    at: typeof r.at === 'string' ? r.at : '',
    reason: typeof r.reason === 'string' ? r.reason : '',
    by: typeof r.by === 'string' ? r.by : '',
    roster: r.roster,
  };
}

/** Whether a finish must treat this run as aborted: it is cancelled, or an abort has begun. */
export function batchAborted(run: { status: string; metadata: unknown }): boolean {
  return run.status === 'cancelled' || readAbortStamp(run.metadata) !== null;
}

export const RUN_NOT_ABORTED = sql`(${pipelineRuns.status} <> 'cancelled' AND ${pipelineRuns.metadata} -> 'abort' IS NULL)`;

/**
 * Stamp the abort before anything else it does. A later abort rewrites the stamp, because the
 * last abort is the one that decided where the roster went.
 */
export async function stampAbort(
  runId: string,
  stamp: { reason: string; by: string; holdPromotedRoster: boolean },
): Promise<void> {
  const held = stamp.holdPromotedRoster && (await runRecordedPromotion(runId));
  const record: AbortStamp = {
    at: new Date().toISOString(),
    reason: stamp.reason,
    by: stamp.by,
    roster: held ? 'held' : 'returning',
  };
  await db.execute(sql`
    UPDATE pipeline_runs
    SET metadata = coalesce(metadata, '{}'::jsonb) || ${JSON.stringify({ abort: record })}::jsonb,
        updated_at = now()
    WHERE id = ${runId}
  `);
}

/** Once the recovery has returned: what it did to the roster, in its own result. */
export async function settleAbortStamp(runId: string, roster: 'held' | 'released'): Promise<void> {
  await db.execute(sql`
    UPDATE pipeline_runs
    SET metadata = jsonb_set(metadata, '{abort,roster}', ${JSON.stringify(roster)}::jsonb),
        updated_at = now()
    WHERE id = ${runId} AND metadata ? 'abort'
  `);
}

export function abortAccount(run: { metadata: unknown; shipped: boolean }): AbortAccount {
  if (run.shipped) return 'shipped';
  return readAbortStamp(run.metadata)?.roster ?? 'unrecorded';
}

/** The refusal for a finish on an aborted batch, carrying what the abort did to it. */
export async function abortedError(
  runId: string,
  executor: Tx = db,
): Promise<ReleaseBatchAbortedError> {
  const rows = await executor.execute<{ project_id: string; metadata: unknown; shipped: boolean }>(
    sql`
      SELECT project_id, metadata, release_released_at IS NOT NULL AS shipped
      FROM pipeline_runs WHERE id = ${runId}
    `,
  );
  const row = rows[0];
  if (!row) throw new Error(`release batch ${runId} not found`);
  return new ReleaseBatchAbortedError(abortAccount(row), row.project_id);
}
