// The abort stamp on a release run (`pipeline_runs.metadata.abort`), and the one predicate every
// finish-side check reads. An abort cannot cancel before it recovers the roster — the run-close
// hook in `claim-subscriber.ts` would race it — so it writes this stamp first, and a batch is
// aborted to a finish from that write on.

import { randomUUID } from 'node:crypto';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { db, type Tx } from '../db/client.js';
import { issues, pipelineRuns } from '../db/schema.js';
import { issueDisplayIds } from '../issues/display-ids.js';
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
  await db.transaction(async (tx) => {
    await tx.execute(sql`
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
    await rewordStoredAbort(runId, tx);
  });
}

/**
 * Re-word an aborted refusal a finish stored while the abort was still `returning` the roster, to
 * the account that abort settled on. Run with the row held: the finish that stored it and the
 * abort that settles it each call this after their own write, so whichever lands second finds the
 * other's. Any other stored account is the one that stood when the attempt ended, and stays.
 */
export async function rewordStoredAbort(runId: string, executor?: Tx): Promise<void> {
  if (!executor) return db.transaction((tx) => rewordStoredAbort(runId, tx));
  const rows = await executor.execute<{ code: string | null; reason: string | null }>(sql`
    SELECT metadata -> 'finish' -> 'refusal' ->> 'code' AS code,
           metadata -> 'finish' -> 'refusal' ->> 'reason' AS reason
    FROM pipeline_runs WHERE id = ${runId} AND metadata -> 'finish' ->> 'state' = 'failed'
    FOR UPDATE
  `);
  const row = rows[0];
  if (row?.code !== ABORTED_CODE || row.reason !== RETURNING_SENTENCE) return;
  const reason = abortedSentence(await abortedError(runId, executor));
  if (reason === row.reason) return;
  await executor.execute(sql`
    UPDATE pipeline_runs
    SET metadata = jsonb_set(metadata, '{finish}', (metadata -> 'finish') || jsonb_build_object(
          'refusal', (metadata -> 'finish' -> 'refusal') || jsonb_build_object('reason', ${reason}::text),
          'version', ((metadata -> 'finish' ->> 'version')::int + 1),
          'updatedAt', ${new Date().toISOString()}::text)),
        updated_at = now()
    WHERE id = ${runId}
  `);
}

const RETURNING_SENTENCE =
  'This batch was aborted, so there is nothing left to finish. The abort had not finished putting its roster back at the release gate when this was read, so each issue’s own status says whether its claim is released yet.';

/** The code a finish on an aborted batch is refused with, at the door and on the stored record. */
export const ABORTED_CODE = 'RELEASE_BATCH_ABORTED';

/** The closed issues the run recorded: its last finish attempt's, and those its claim releases wrote. */
function recordedClosed(metadata: unknown): string[] {
  const m = metadata as { finish?: { closed?: unknown }; rosterClosed?: unknown } | null;
  return [m?.finish?.closed, m?.rosterClosed].flatMap((list) =>
    Array.isArray(list) ? list.filter((id): id is string => typeof id === 'string') : [],
  );
}

function union(...lists: string[][]): string[] {
  return [...new Set(lists.flat())].sort();
}

/**
 * The roster issues closed when an abort ran: those its recovery found claimed and closed, and
 * those the run recorded closing — its finish attempt, its claim releases, an earlier abort — whose
 * claims are gone. Each is read back at its status now, so one reopened since is not answered.
 */
export async function closedBeforeAbort(
  runId: string,
  claimedClosed: string[],
  executor: Tx = db,
): Promise<string[]> {
  const rows = await executor.execute<{ metadata: unknown }>(
    sql`SELECT metadata FROM pipeline_runs WHERE id = ${runId}`,
  );
  const metadata = rows[0]?.metadata;
  const candidates = union(
    claimedClosed,
    readAbortStamp(metadata)?.closed ?? [],
    recordedClosed(metadata),
  );
  if (candidates.length === 0) return [];
  const closed = await executor
    .select({ id: issues.id })
    .from(issues)
    .where(and(inArray(issues.id, candidates), eq(issues.status, 'closed')));
  return closed.map((r) => r.id).sort();
}

/** What the abort did, and the roster issues closed before it: the stamp's, the run's records,
 *  and a held roster's still-claimed ones; `null` where nothing recorded them. */
export function abortAccount(run: { metadata: unknown; shipped: boolean; heldClosed: string[] }): {
  account: AbortAccount;
  closed: string[] | null;
} {
  if (run.shipped) return { account: 'shipped', closed: null };
  const stamp = readAbortStamp(run.metadata);
  if (!stamp) return { account: 'unrecorded', closed: null };
  if (stamp.roster === 'returning') return { account: 'returning', closed: null };
  const known = union(stamp.closed ?? [], recordedClosed(run.metadata));
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
  const shown = await issueDisplayIds(closed ?? [], executor);
  return new ReleaseBatchAbortedError(account, row.project_id, closed, shown);
}

/** What a finish on an aborted batch is told, by what the abort did to that batch. */
export function abortedSentence(err: ReleaseBatchAbortedError): string {
  const none = 'This batch was aborted, so there is nothing left to finish';
  const closed = err.closed ?? [];
  const kept = closed.length > 0 ? ` ${closedBeforeAbortSentence(closed, err.shown)}` : '';
  switch (err.account) {
    case 'shipped':
      return `${none}: its release had already shipped, so the issues its finish closed stay closed, and the abort moved none of them.`;
    case 'held': {
      const rest = closed.length > 0 ? 'Every other issue stays' : 'Its issues stay';
      // `release-records` takes only issues at the gate that no batch claims, so the abort that
      // puts them there comes first and is never offered beside it.
      return `${none}: it recorded a promotion, so the abort kept its claims.${kept} ${rest} at \`awaiting_release\` at their \`release\` step, still claimed, for a person to settle. To settle them, abort this batch again with \`promotedRoster: "return-to-gate"\`, which puts them back at the release gate; once they are there, if the release did land, record it with POST /api/projects/${err.projectId}/release-records, naming the commit production is serving.`;
    }
    case 'returning':
      return RETURNING_SENTENCE;
    case 'released':
      if (closed.length > 0) {
        return `${none}.${kept} Its claims were released and the rest of its roster is back where the abort put it. If the release did land after all, that is a person’s call to make on each of those.`;
      }
      return `${none}: its claims were released and its roster is back where the abort put it. If the release did land after all, that is a person’s call to make on each issue.`;
    case 'unrecorded':
      return 'This batch’s run was cancelled, so there is nothing left to finish. Nothing on the run records what that did to its issues, so each issue’s own status and notes are the account; if the release did land after all, that is a person’s call to make on each issue.';
  }
}

/** The issues a finish closed before the abort landed, by the key a person knows each by. */
function closedBeforeAbortSentence(ids: string[], shown: ReadonlyMap<string, string>): string {
  const one = ids.length === 1;
  const names = ids
    .map((id) => shown.get(id) ?? id)
    .sort((a, b) => a.localeCompare(b, 'en', { numeric: true }));
  return `Its finish had already closed ${names.join(', ')} before the abort, and ${one ? 'it stays' : 'they stay'} closed.`;
}
