/**
 * The audit line a mark or an unmark leaves as its comment's first line, and its one reader.
 *
 * The tracker keeps no structured field for the commit an `asserted` mark claims: `merge-marker.ts`
 * `writeMarkTrail` writes it into the first line as `commit=<40 hex>`. That line is written here and
 * read here, so the two cannot drift. Each stamping mark and each unmark leaves exactly one; a mark
 * the first stamp outranked says `NOT stamped by this call` and claims nothing.
 *
 * The claim that stands is the CURRENT mark's own: the newest of those lines, read only where it is
 * a mark naming a commit. A later unmark withdrew every earlier claim, and a later mark naming no
 * commit is the current mark and claims none (ISS-489: round 1's withdrawn claim closed the issue
 * into the release that shipped round 1).
 */

import { sql } from 'drizzle-orm';
import { db, type Tx } from '../db/client.js';

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

const MARK_LINE = '^mark_merged( target=\\S+)?( commit=[0-9a-f]{40})?( |$)';
const UNMARK_LINE = '^unmark( |$)';
const CLAIM = '^mark_merged(?: target=\\S+)? commit=([0-9a-f]{40})(?: |$)';

/**
 * The commit each issue's current mark claims, by issue id; an issue whose newest trail line is an
 * unmark or a mark naming no commit is absent. On an exact tie the unmark is read as newer, so a
 * withdrawn claim is never the one that stands.
 */
export async function currentMarkClaims(
  issueIds: readonly string[],
  executor: Pick<Tx, 'execute'> = db,
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (issueIds.length === 0) return out;
  const found = (await executor.execute(sql`
    SELECT DISTINCT ON (c.issue_id) c.issue_id,
           substring(split_part(c.body, E'\\n', 1) from ${CLAIM}) AS sha
      FROM comments c
     WHERE c.issue_id IN (${sql.join(
       issueIds.map((id) => sql`${id}::uuid`),
       sql`, `,
     )})
       AND (split_part(c.body, E'\\n', 1) ~ ${MARK_LINE} OR split_part(c.body, E'\\n', 1) ~ ${UNMARK_LINE})
       AND position(${NOT_STAMPED} in c.body) = 0
     ORDER BY c.issue_id, c.created_at DESC, (split_part(c.body, E'\\n', 1) ~ ${UNMARK_LINE}) DESC
  `)) as unknown as Array<{ issue_id: string; sha: string | null }>;
  for (const r of found) if (r.sha) out.set(r.issue_id, r.sha.toLowerCase());
  return out;
}

/** When `issueId` was last unmarked, from its trail; null where it never was. */
export async function lastUnmarkedAt(
  issueId: string,
  executor: Pick<Tx, 'execute'> = db,
): Promise<Date | null> {
  const [row] = (await executor.execute(sql`
    SELECT max(c.created_at) AS at FROM comments c
     WHERE c.issue_id = ${issueId}::uuid AND split_part(c.body, E'\\n', 1) ~ ${UNMARK_LINE}
  `)) as unknown as Array<{ at: Date | string | null }>;
  return row?.at ? new Date(row.at) : null;
}
