/**
 * The trail a mark or an unmark leaves, and its one reader.
 *
 * The tracker keeps no column for the commit an `asserted` mark claims. The marker
 * (`merge-marker.ts` `writeMarkTrail`) keeps it two ways in its own transaction: as the first line
 * of the audit comment people read (`markTrailLabel`), and as the record this module reads, one
 * `activity_log` row per mark or unmark (`recordMarkTrail`). Only the record is read. A comment is
 * text anybody with a comment door can type, and its author is the caller either way, so a comment
 * shaped like a trail line is never a claim and never an unmark (ISS-489 r5; kernel input,
 * `VISION: kernel-hard-policy-soft`).
 *
 * The claim that stands is the CURRENT mark's own: the newest stamped mark or unmark, read only where
 * it is a mark naming a commit. A later unmark withdrew every earlier claim, and a later mark naming
 * no commit is the current mark and claims none (ISS-489 r4: round 1's withdrawn claim closed the
 * issue into the release that shipped round 1). A mark the first stamp outranked records
 * `stamped: false` and claims nothing.
 *
 * An unmark made before the record existed is read from the activity feed's own row for it: the
 * `issue.updated` row the unmark's event wrote, setting `mergedAt` to null, which only an unmark does
 * (`merge-record.ts` `clearIssueMerge`). A claim from then has no record and counts as none: the
 * issue is held `SHIPPED_EARLIER_NO_COMMIT` until it is marked again, never closed by it.
 */

import { sql } from 'drizzle-orm';
import { db, type Tx } from '../db/client.js';
import { type Actor, recordActivityTx } from './activity.js';

/** The first line of the audit comment a mark (`commit` claimed or observed) or an unmark leaves. */
export function markTrailLabel(
  op: 'mark' | 'unmark',
  target: string | undefined,
  commit: string | null,
): string {
  if (op === 'unmark') return 'unmark';
  return `mark_merged${target ? ` target=${target}` : ''}${commit ? ` commit=${commit}` : ''}`;
}

/** Written into a mark's comment when the first stamp outranked it, so it claims nothing. */
export const NOT_STAMPED = 'NOT stamped by this call';

/** The `activity_log` actions the marker writes, and the only trail this module reads. */
export const MARK_RECORD = 'issue.mergeMarked';
export const UNMARK_RECORD = 'issue.mergeUnmarked';

/** One trail record, in the marker's transaction, beside the audit comment it stands for. */
export async function recordMarkTrail(
  tx: Tx,
  trail: {
    issueId: string;
    actor: Actor;
    commentId: string;
  } & (
    | { op: 'mark'; target: string | null; commit: string | null; stamped: boolean }
    | { op: 'unmark' }
  ),
): Promise<void> {
  const { issueId, actor, commentId } = trail;
  await recordActivityTx(tx, {
    issueId,
    actor,
    action: trail.op === 'mark' ? MARK_RECORD : UNMARK_RECORD,
    payload:
      trail.op === 'mark'
        ? { commentId, target: trail.target, commit: trail.commit, stamped: trail.stamped }
        : { commentId },
  });
}

/** An unmark: its record, or the feed's row for an unmark made before records existed. */
const IS_UNMARK = sql`(a.action = ${UNMARK_RECORD}
  OR (a.action = 'issue.updated'
      AND a.payload -> 'changes' @> '[{"path":["mergedAt"],"after":null}]'::jsonb))`;

/** A mark the stamp took. A mark it outranked changed nothing and is not the current mark. */
const IS_STAMPED_MARK = sql`(a.action = ${MARK_RECORD} AND (a.payload ->> 'stamped')::boolean)`;

/**
 * The commit each issue's current mark claims, by issue id; an issue whose newest trail record is an
 * unmark, or a mark naming no whole commit, is absent. On an exact tie the unmark is read as newer,
 * so a withdrawn claim is never the one that stands.
 */
export async function currentMarkClaims(
  issueIds: readonly string[],
  executor: Pick<Tx, 'execute'> = db,
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (issueIds.length === 0) return out;
  const found = (await executor.execute(sql`
    SELECT DISTINCT ON (a.issue_id) a.issue_id,
           CASE WHEN a.action = ${MARK_RECORD} THEN a.payload ->> 'commit' END AS sha
      FROM activity_log a
     WHERE a.issue_id IN (${sql.join(
       issueIds.map((id) => sql`${id}::uuid`),
       sql`, `,
     )})
       AND (${IS_STAMPED_MARK} OR ${IS_UNMARK})
     ORDER BY a.issue_id, a.created_at DESC, (a.action = ${MARK_RECORD}) ASC
  `)) as unknown as Array<{ issue_id: string; sha: string | null }>;
  for (const r of found) {
    const sha = r.sha?.toLowerCase() ?? null;
    if (sha && /^[0-9a-f]{40}$/.test(sha)) out.set(r.issue_id, sha);
  }
  return out;
}

/** When `issueId` was last unmarked, from its trail records; null where it never was. */
export async function lastUnmarkedAt(
  issueId: string,
  executor: Pick<Tx, 'execute'> = db,
): Promise<Date | null> {
  const [row] = (await executor.execute(sql`
    SELECT max(a.created_at) AS at FROM activity_log a
     WHERE a.issue_id = ${issueId}::uuid AND ${IS_UNMARK}
  `)) as unknown as Array<{ at: Date | string | null }>;
  return row?.at ? new Date(row.at) : null;
}
