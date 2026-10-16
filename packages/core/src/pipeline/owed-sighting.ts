/**
 * ISS-1229 r12 — a paged sweep sights a row once a traversal, but its notice is delivered only after
 * two evaluations pending and dropped after three unseen (`notifications/kinds.ts`, `deliver.ts`),
 * so beside its page a pass also reads each row whose notice is pending and the newest not raised.
 */

import { type SQL, sql } from 'drizzle-orm';

export const FRESH_SIGHTING_LIMIT = 200;

/** A row stays pending three passes, and a pass raises at most its page and its fresh rows. */
export function pendingSightingLimit(pageLimit: number): number {
  return 3 * (pageLimit + FRESH_SIGHTING_LIMIT);
}

function conditionKey(issueId: SQL, keySuffix: string): SQL {
  return sql`('issue:' || (${issueId})::text || ${keySuffix})`;
}

export function pendingConditionSql(issueId: SQL, keySuffix: string): SQL {
  return sql`EXISTS (
    SELECT 1 FROM notifications owed
     WHERE owed.resolution_key = ${conditionKey(issueId, keySuffix)}
       AND owed.resolved_at IS NULL
       AND owed.type = 'issue_stranded'
       AND owed.state = 'pending'
  )`;
}

export function unraisedConditionSql(issueId: SQL, keySuffix: string): SQL {
  return sql`NOT EXISTS (
    SELECT 1 FROM notifications raised
     WHERE raised.resolution_key = ${conditionKey(issueId, keySuffix)}
       AND raised.resolved_at IS NULL
       AND raised.type = 'issue_stranded'
  )`;
}

export function withOwed<T extends { id: string }>(
  page: readonly T[],
  ...owed: ReadonlyArray<readonly T[]>
): T[] {
  const out = [...page];
  const held = new Set(page.map((r) => r.id));
  for (const rows of owed) {
    for (const row of rows) {
      if (held.has(row.id)) continue;
      held.add(row.id);
      out.push(row);
    }
  }
  return out;
}
