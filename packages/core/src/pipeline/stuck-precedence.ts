/**
 * ISS-1229 r14 — one issue, one stuck reason. The four sweeps' conditions overlap, so the most
 * specific reason tells it, and a less specific one neither raises beside it nor outlives it.
 */

import { type SQL, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { resolveNotifications } from '../notifications/auto-resolve.js';
import { STUCK_NOTICES } from '../projects/stuck-issue-kinds.js';

export const STUCK_NOTICE_PRECEDENCE = STUCK_NOTICES.map((n) => n.suffix);
export type StuckNoticeSuffix = (typeof STUCK_NOTICES)[number]['suffix'];

/**
 * Whether a more specific stuck-issue notice is told for this issue: then this sweep says nothing.
 * Only a firing one outranks, so an issue is never left told nothing while the other waits to fire.
 */
export function outrankedSql(issueId: SQL, suffix: StuckNoticeSuffix): SQL {
  const above = STUCK_NOTICE_PRECEDENCE.slice(0, STUCK_NOTICE_PRECEDENCE.indexOf(suffix));
  if (above.length === 0) return sql`false`;
  return sql`EXISTS (
    SELECT 1 FROM notifications pn
     WHERE pn.issue_id = ${issueId}
       AND pn.type = 'issue_stranded'
       AND pn.resolved_at IS NULL
       AND pn.state = 'firing'
       AND (${sql.join(
         above.map((s) => sql`pn.resolution_key LIKE ${`issue:%${s}`}`),
         sql` OR `,
       )})
  )`;
}

export async function resolveOutrankedNotices(suffix: StuckNoticeSuffix): Promise<number> {
  const rows = (await db.execute(sql`
    SELECT DISTINCT n.resolution_key AS "key"
      FROM notifications n
     WHERE n.type = 'issue_stranded'
       AND n.resolved_at IS NULL
       AND n.resolution_key LIKE ${`issue:%${suffix}`}
       AND n.issue_id IS NOT NULL
       AND ${outrankedSql(sql`n.issue_id`, suffix)}
  `)) as unknown as Array<{ key: string }>;
  let resolved = 0;
  for (const { key } of rows) resolved += await resolveNotifications(key);
  return resolved;
}

/** Called by each sweep once it has told what it found: the reason it raised retires the lesser one. */
export async function retireOutrankedNotices(): Promise<number> {
  let resolved = 0;
  for (const suffix of STUCK_NOTICE_PRECEDENCE.slice(1))
    resolved += await resolveOutrankedNotices(suffix);
  return resolved;
}

export async function outrankedIssueIds(
  issueIds: readonly string[],
  suffix: StuckNoticeSuffix,
): Promise<Set<string>> {
  if (issueIds.length === 0) return new Set();
  const rows = (await db.execute(sql`
    SELECT i.id FROM unnest(${`{${issueIds.join(',')}}`}::uuid[]) AS i(id)
     WHERE ${outrankedSql(sql`i.id`, suffix)}
  `)) as unknown as Array<{ id: string }>;
  return new Set(rows.map((r) => r.id));
}
