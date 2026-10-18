import type { StuckIssueKind } from '@forge/contracts/notifications';
import { sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { stuckKindSql, stuckRankSql } from './stuck-issue-kinds.js';

/**
 * The kind each of these issues is told by, its most specific standing reason, as the health row's
 * count reads it; an issue no stuck-issue notice stands for has no entry (ISS-1229 r15).
 */
export async function readStuckKinds(
  issueIds: readonly string[],
): Promise<Map<string, StuckIssueKind>> {
  const ids = [...new Set(issueIds)];
  if (ids.length === 0) return new Map();
  const rows = (await db.execute(sql`
    SELECT DISTINCT ON (n.issue_id) n.issue_id AS "issueId",
           ${stuckKindSql(sql`n.resolution_key`)} AS kind
      FROM notifications n
     WHERE n.issue_id IN (${sql.join(
       ids.map((id) => sql`${id}`),
       sql`, `,
     )})
       AND n.type = 'issue_stranded'
       AND n.state = 'firing'
       AND n.resolved_at IS NULL
     ORDER BY n.issue_id, ${stuckRankSql(sql`n.resolution_key`)}, n.created_at
  `)) as unknown as { issueId: string; kind: StuckIssueKind }[];
  return new Map(rows.map((r) => [r.issueId, r.kind]));
}
