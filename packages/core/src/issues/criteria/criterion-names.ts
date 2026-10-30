// The issue's live criteria as a `criterion` value is matched against (`messaging/criterion-named.ts`):
// each one's number, its statement, and the BC its row is traced to, which a writer may put back on
// the line as its lead tag although the statement carries none.

import { sql } from 'drizzle-orm';
import type { Tx } from '../../db/client.js';
import type { NamedCriterion } from '../../messaging/criterion-named.js';

export async function namedCriteriaOf(
  executor: Pick<Tx, 'execute'>,
  issueId: string,
): Promise<NamedCriterion[]> {
  const rows = (await executor.execute(sql`
    SELECT c.n, c.statement, r.req_seq, rc.code
      FROM issue_criteria c
      LEFT JOIN requirement_criteria rc ON rc.id = c.requirement_criterion_id
      LEFT JOIN requirements r ON r.id = rc.requirement_id
     WHERE c.issue_id = ${issueId} AND c.retired_at IS NULL
     ORDER BY c.n
  `)) as unknown as Array<{
    n: number;
    statement: string;
    req_seq: number | null;
    code: string | null;
  }>;
  return rows.map((r) => ({
    n: Number(r.n),
    statement: r.statement,
    trace: r.req_seq === null || r.code === null ? null : `REQ-${Number(r.req_seq)} ${r.code}`,
  }));
}
