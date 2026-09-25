// The abort stamp on a release run (`pipeline_runs.metadata.abort`), and the one predicate every
// finish-side check reads. An abort cannot cancel before it recovers the roster — the run-close
// hook in `claim-subscriber.ts` would race it — so it writes this stamp first, and a batch is
// aborted to a finish from that write on.

import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { db, type Tx } from '../db/client.js';
import { pipelineRuns } from '../db/schema.js';
import { type AbortAccount, ReleaseBatchAbortedError } from './errors.js';
import { closedOnRoster, runRecordedPromotion } from './releasing-recovery.js';

export interface AbortStamp {
  id: string;
  at: string;
  reason: string;
  by: string;
  /** `returning` until the recovery has put the roster back and released its claims. */
  roster: 'held' | 'returning' | 'released';
  closed: string[] | null;
}

export function readAbortStamp(metadata: unknown): AbortStamp | null {
  const raw = (metadata as { abort?: unknown } | null)?.abort;
  if (typeof raw !== 'object' || raw === null) return null;
  const r = raw as Record<string, unknown>;
  if (r.roster !== 'held' && r.roster !== 'returning' && r.roster !== 'released') return null;
  return {
    id: typeof r.id === 'string' ? r.id : '',
    at: typeof r.at === 'string' ? r.at : '',
    reason: typeof r.reason === 'string' ? r.reason : '',
    by: typeof r.by === 'string' ? r.by : '',
    roster: r.roster,
    closed: Array.isArray(r.closed)
      ? r.closed.filter((id): id is string => typeof id === 'string')
      : null,
  };
}

/** Whether a finish must treat this run as aborted: it is cancelled, or an abort has begun. */
export function batchAborted(run: { status: string; metadata: unknown }): boolean {
  return run.status === 'cancelled' || readAbortStamp(run.metadata) !== null;
}

export const RUN_NOT_ABORTED = sql`(${pipelineRuns.status} <> 'cancelled' AND ${pipelineRuns.metadata} -> 'abort' IS NULL)`;

/**
 * Stamp the abort before anything else it does. A later abort rewrites the stamp, because the
 * last abort is the one that decided where the roster went — keeping the closed issues an earlier
 * one recorded, whose claims it released.
 */
export async function stampAbort(
  runId: string,
  stamp: { reason: string; by: string; holdPromotedRoster: boolean },
): Promise<string> {
  const held = stamp.holdPromotedRoster && (await runRecordedPromotion(runId));
  const record: AbortStamp = {
    id: randomUUID(),
    at: new Date().toISOString(),
    reason: stamp.reason,
    by: stamp.by,
    roster: held ? 'held' : 'returning',
    closed: null,
  };
  await db.execute(sql`
    UPDATE pipeline_runs
    SET metadata = coalesce(metadata, '{}'::jsonb) || jsonb_build_object('abort',
          ${JSON.stringify(record)}::jsonb
          || jsonb_build_object('closed', coalesce(metadata -> 'abort' -> 'closed', 'null'::jsonb))),
        updated_at = now()
    WHERE id = ${runId}
  `);
  return record.id;
}

/**
 * Once the recovery has returned, what it did — onto its own stamp only, never a later abort's.
 * `closed` joins what the stamp already held: the recovery read the roster after the stamp
 * committed and every close refuses a stamped run, so no close comes after it.
 */
export async function settleAbortStamp(
  runId: string,
  stampId: string,
  settled: { roster: 'held' | 'released'; closed: string[] },
): Promise<void> {
  await db.execute(sql`
    UPDATE pipeline_runs
    SET metadata = jsonb_set(metadata, '{abort}', (metadata -> 'abort') || jsonb_build_object(
          'roster', ${settled.roster}::text,
          'closed', (SELECT coalesce(jsonb_agg(DISTINCT id), '[]'::jsonb) FROM jsonb_array_elements_text(
            (CASE WHEN jsonb_typeof(metadata -> 'abort' -> 'closed') = 'array'
                  THEN metadata -> 'abort' -> 'closed' ELSE '[]'::jsonb END)
            || ${JSON.stringify(settled.closed)}::jsonb) AS t(id)))),
        updated_at = now()
    WHERE id = ${runId} AND metadata -> 'abort' ->> 'id' = ${stampId}
  `);
}

/** The issues the last finish attempt recorded as closed, off the run's finish record. */
function finishClosed(metadata: unknown): string[] {
  const closed = (metadata as { finish?: { closed?: unknown } } | null)?.finish?.closed;
  return Array.isArray(closed) ? closed.filter((id): id is string => typeof id === 'string') : [];
}

function union(...lists: string[][]): string[] {
  return [...new Set(lists.flat())].sort();
}

/** What the abort did, and the roster issues closed before it: the stamp's, the finish record's,
 *  and a held roster's still-claimed ones; `null` where the stamp never recorded them. */
export function abortAccount(run: { metadata: unknown; shipped: boolean; heldClosed: string[] }): {
  account: AbortAccount;
  closed: string[] | null;
} {
  if (run.shipped) return { account: 'shipped', closed: null };
  const stamp = readAbortStamp(run.metadata);
  if (!stamp) return { account: 'unrecorded', closed: null };
  if (stamp.roster === 'returning') return { account: 'returning', closed: null };
  const known = union(stamp.closed ?? [], finishClosed(run.metadata));
  if (stamp.roster === 'held') return { account: 'held', closed: union(known, run.heldClosed) };
  return {
    account: 'released',
    closed: stamp.closed === null && known.length === 0 ? null : known,
  };
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
  const heldClosed = await closedOnRoster(runId, executor);
  const { account, closed } = abortAccount({ ...row, heldClosed });
  return new ReleaseBatchAbortedError(account, row.project_id, closed);
}
