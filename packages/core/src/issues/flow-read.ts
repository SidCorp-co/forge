/**
 * How a project's issues move (REQ-43 r3 BC-16), the Issues page band's one chart: issues filed and
 * issues closed on each of the last `ISSUE_FLOW_DAYS` days in the reader's zone. Filed counts the
 * issues the list counts (not archived); closed counts each issue's moves into a terminal status, the
 * statuses the list's Closed scope holds, once per issue per day. The instants are read raw and the
 * day is counted here by `day-keys.ts`, the rule the home and every band count a day by.
 */

import { dayKeyIn, daysEnding } from '@forge/contracts/day-keys';
import { ISSUE_FLOW_DAYS, type IssueFlow } from '@forge/contracts/issue-flow';
import { ISSUE_TERMINAL_STATUSES } from '@forge/contracts/issue-machine';
import { sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { idList, rowsOf } from '../db/raw-sql.js';

const DAY_MS = 86_400_000;

/** Folds the instants into the days ending `today`, each closed issue once per day. */
export function issueFlowOf(
  opened: readonly { at: Date | string }[],
  closed: readonly { issueId: string; at: Date | string }[],
  dayOf: (at: Date | string) => string,
  today: string,
): IssueFlow['days'] {
  const days = new Map(
    daysEnding(today, ISSUE_FLOW_DAYS).map((day) => [day, { day, opened: 0, closed: 0 }]),
  );
  for (const o of opened) {
    const d = days.get(dayOf(o.at));
    if (d) d.opened += 1;
  }
  const seen = new Set<string>();
  for (const c of closed) {
    const day = dayOf(c.at);
    const d = days.get(day);
    if (!d || seen.has(`${day}:${c.issueId}`)) continue;
    seen.add(`${day}:${c.issueId}`);
    d.closed += 1;
  }
  return [...days.values()];
}

export async function readIssueFlow(
  projectId: string,
  tz: string,
  now: Date = new Date(),
): Promise<IssueFlow> {
  // a day wider than the window on its far side, so no zone's first day is cut; the fold drops the rest
  const since = new Date(now.getTime() - (ISSUE_FLOW_DAYS + 1) * DAY_MS).toISOString();
  const [opened, closed] = await Promise.all([
    db.execute(sql`
      SELECT created_at AS at FROM issues
       WHERE project_id = ${projectId} AND archived_at IS NULL AND created_at >= ${since}::timestamptz`),
    db.execute(sql`
      SELECT a.issue_id AS "issueId", a.created_at AS at
        FROM activity_log a JOIN issues i ON i.id = a.issue_id
       WHERE i.project_id = ${projectId} AND i.archived_at IS NULL AND a.created_at >= ${since}::timestamptz
         AND a.action = 'issue.statusChanged'
         AND a.payload ->> 'to' IN (${idList(ISSUE_TERMINAL_STATUSES)})`),
  ]);
  const dayOf = dayKeyIn(tz);
  return {
    projectId,
    tz,
    days: issueFlowOf(
      rowsOf<{ at: Date | string }>(opened),
      rowsOf<{ issueId: string; at: Date | string }>(closed),
      dayOf,
      dayOf(now),
    ),
  };
}
