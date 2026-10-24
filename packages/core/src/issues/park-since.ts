// When the wait a `needs_info` park holds now began: its move into `needs_info`, or the newest
// re-point or re-kind of it since (`park-repoint.ts`), which moves no status and so writes no
// `kernel_transitions` row. Each of them writes the park record (`record.park`, status `needs_info`)
// in its own transaction, so the newest such record is that moment; a park entered before park
// records were written has only its move. The question the park asked is the one created at this
// moment (`questions/issue-coupling.ts:parkQuestionsOf`), and an answer given before it answered an
// earlier wait, never this one (`standing-read.ts`, `park-view.ts`).

import { recordAction } from '@forge/contracts/record-events';
import { type SQL, type SQLWrapper, sql } from 'drizzle-orm';
import type { IssueDependencyExecutor } from './dependency-executor.js';

const PARK_RECORD = recordAction('park');
const AT_NEEDS_INFO = JSON.stringify([{ key: 'status', value: 'needs_info' }]);

/** The moment the issue's current `needs_info` wait began, or NULL where it never parked there. */
export function parkSinceSql(issueId: SQLWrapper): SQL {
  return sql`greatest(
    (SELECT max(k.created_at) FROM kernel_transitions k
      WHERE k.entity = 'issue' AND k.entity_id = ${issueId} AND k.to_status = 'needs_info'),
    (SELECT max(a.created_at) FROM activity_log a
      WHERE a.issue_id = ${issueId} AND a.action = ${PARK_RECORD}
        AND a.payload -> 'fields' @> ${AT_NEEDS_INFO}::jsonb))`;
}

/** `parkSinceSql` read for one issue. */
export async function parkSince(executor: IssueDependencyExecutor, issueId: string) {
  const rows = (await executor.execute(
    sql`SELECT ${parkSinceSql(sql`${issueId}::uuid`)} AS since`,
  )) as unknown as Array<{ since: Date | string | null }>;
  const since = rows[0]?.since ?? null;
  return since === null ? null : new Date(since);
}
