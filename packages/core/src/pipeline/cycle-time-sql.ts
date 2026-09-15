import { type SQL, sql } from 'drizzle-orm';
import { activityLog, issues } from '../db/schema.js';

// cm:guard the ONE place the transitions scan is written, exported so `tests/integration/bounded-read-indexes.test.ts` can `EXPLAIN` the statement this route actually sends rather than a hand-copied likeness of it: the index this read depends on is chosen by the whole shape — the join, the window functions and the payload extraction included — so a copy that drifts turns criterion 54 into a test of the copy (ISS-1022).
export function cycleTimeTransitionsSql(projectIds: string[], days: number): SQL {
  return sql`
      SELECT
        ${activityLog.issueId} AS issue_id,
        ${issues.projectId} AS project_id,
        ${activityLog.payload} ->> 'to' AS to_status,
        ${activityLog.createdAt} AS created_at,
        LAG(${activityLog.createdAt}) OVER (
          PARTITION BY ${activityLog.issueId}
          ORDER BY ${activityLog.createdAt}
        ) AS prev_created_at,
        LAG(${activityLog.payload} ->> 'to') OVER (
          PARTITION BY ${activityLog.issueId}
          ORDER BY ${activityLog.createdAt}
        ) AS prev_to
      FROM ${activityLog}
      INNER JOIN ${issues} ON ${issues.id} = ${activityLog.issueId}
      WHERE ${activityLog.action} = 'issue.statusChanged'
        AND ${issues.projectId} IN ${projectIds}
        AND ${activityLog.createdAt} >= now() - (${days}::int * interval '1 day')`;
}
