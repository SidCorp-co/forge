/** The chained count a score is worth `blocks` points per, and the blockers a change below moves (ISS-1336); tracker `blocks` edges only. */

import { sql } from 'drizzle-orm';
import { BLOCKER_SETTLED_STATUSES } from '../dependency-effects.js';
import { type IndexExecutor, rowsOf, textList, uuidArray } from './index-sql.js';

/** A dependent in one of these no longer waits, `dropped` included. */
export const RANK_ENDED_STATUSES: readonly string[] = [
  ...BLOCKER_SETTLED_STATUSES,
  'tested',
  'releasing',
  'dropped',
];

export interface ChainOf {
  count: number;
  /** The first moment an edge on the walk lapses, after which the count is not what a read would say. */
  lapsesAt: Date | null;
}

/**
 * For each issue, the issues it holds up through live `blocks` edges, counted through the chain:
 * blocking one that blocks three counts four. A cycle ends on the pair already met, and the walk
 * stops at a dependent that no longer waits.
 */
export async function chainsOf(
  executor: IndexExecutor,
  projectId: string,
  issueIds: readonly string[],
): Promise<Map<string, ChainOf>> {
  const out = new Map<string, ChainOf>(issueIds.map((id) => [id, { count: 0, lapsesAt: null }]));
  if (issueIds.length === 0) return out;
  const rows = await rowsOf(
    executor,
    sql`
    WITH RECURSIVE down(root, id, lapse) AS (
      SELECT r.id, r.id, NULL::timestamptz FROM unnest(${uuidArray(issueIds)}) AS r(id)
      UNION
      SELECT down.root, d.to_issue_id,
             CASE WHEN d.valid_until IS NULL THEN down.lapse ELSE LEAST(down.lapse, d.valid_until) END
        FROM down
        JOIN issue_dependencies d
          ON d.from_issue_id = down.id AND d.project_id = ${projectId}::uuid AND d.kind = 'blocks'
         AND (d.valid_until IS NULL OR d.valid_until > now())
        JOIN issues t ON t.id = d.to_issue_id AND t.status NOT IN (${textList(RANK_ENDED_STATUSES)})
    )
    SELECT root::text AS root,
           count(DISTINCT id) FILTER (WHERE id <> root)::int AS chained,
           min(lapse) AS lapses_at
      FROM down GROUP BY root`,
  );
  for (const row of rows) {
    out.set(String(row.root), {
      count: Number(row.chained),
      lapsesAt: row.lapses_at ? new Date(String(row.lapses_at)) : null,
    });
  }
  return out;
}

/**
 * The issues whose chain a change at `issueIds` can move: the issues themselves and everything
 * that holds them up, transitively, since a chain counts what is below. What is below them is
 * unchanged, so it is not returned.
 */
export async function withBlockers(
  executor: IndexExecutor,
  projectId: string,
  issueIds: readonly string[],
): Promise<string[]> {
  if (issueIds.length === 0) return [];
  const rows = await rowsOf(
    executor,
    sql`
    WITH RECURSIVE up(id) AS (
      SELECT r.id FROM unnest(${uuidArray(issueIds)}) AS r(id)
      UNION
      SELECT d.from_issue_id
        FROM up
        JOIN issue_dependencies d
          ON d.to_issue_id = up.id AND d.project_id = ${projectId}::uuid AND d.kind = 'blocks'
         AND (d.valid_until IS NULL OR d.valid_until > now())
    )
    SELECT id::text AS id FROM up`,
  );
  return rows.map((row) => String(row.id));
}
