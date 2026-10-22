/**
 * What a draft issue holds that a merge would not carry (REQ-48 BC-5): the steward's merge moves a
 * draft's text into another issue, not its edges, so a draft holding a live `blocks` edge is not
 * merged by rule.
 */

import { sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { rowsOf } from '../db/raw-sql.js';
import { formatIssueRef } from '../lib/issue-ref.js';
import { DISPATCH_GATING_KIND } from './dependency-effects.js';

/** The issues a draft holds through a live `blocks` edge, by key. */
export async function draftMergeHolds(issueId: string): Promise<string[]> {
  const rows = rowsOf<{ iss_seq: number; issue_prefix: string | null }>(
    await db.execute(sql`
      SELECT t.iss_seq, p.issue_prefix
        FROM issue_dependencies d
        JOIN issues t ON t.id = d.to_issue_id
        JOIN projects p ON p.id = t.project_id
       WHERE d.from_issue_id = ${issueId} AND d.kind = ${DISPATCH_GATING_KIND}
         AND (d.valid_until IS NULL OR d.valid_until > now())
         AND t.status NOT IN ('dropped', 'closed')
       ORDER BY t.iss_seq`),
  );
  return rows.map((r) => formatIssueRef(r.issue_prefix, Number(r.iss_seq)));
}
