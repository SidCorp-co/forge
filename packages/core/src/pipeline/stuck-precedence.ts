/**
 * ISS-1229 r14 — one issue, one stuck reason. Four sweeps each tell a project's admins about an issue
 * nothing is working, and their conditions overlap: an In progress issue with no run is named an
 * orphan at ten minutes and idle at two hours, so judge-35's bell held it twice and the project
 * page's headline counted ten for eight issues. The most specific reason tells it, and a less
 * specific one neither raises beside it nor outlives it.
 */

import { type SQL, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { resolveNotifications } from '../notifications/auto-resolve.js';

/** Each sweep's resolution-key suffix, most specific first: a park waiting for a person, a shipped
 *  issue never closed, work asserted with no run behind it, then a live status nothing works. */
export const STUCK_NOTICE_PRECEDENCE = [
  ':stranded',
  ':owed-close',
  ':run-assertion-orphaned',
  ':idle',
] as const;
export type StuckNoticeSuffix = (typeof STUCK_NOTICE_PRECEDENCE)[number];

/** Whether a more specific stuck-issue notice stands for this issue: then this sweep says nothing. */
export function outrankedSql(issueId: SQL, suffix: StuckNoticeSuffix): SQL {
  const above = STUCK_NOTICE_PRECEDENCE.slice(0, STUCK_NOTICE_PRECEDENCE.indexOf(suffix));
  if (above.length === 0) return sql`false`;
  return sql`EXISTS (
    SELECT 1 FROM notifications pn
     WHERE pn.issue_id = ${issueId}
       AND pn.type = 'issue_stranded'
       AND pn.resolved_at IS NULL
       AND pn.state IN ('pending', 'firing', 'inhibited')
       AND (${sql.join(
         above.map((s) => sql`pn.resolution_key LIKE ${`issue:%${s}`}`),
         sql` OR `,
       )})
  )`;
}

/** End every notice of this sweep's that a more specific one now stands beside; how many ended. */
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

/** Of these issues, the ones a more specific stuck-issue notice already stands for. */
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
