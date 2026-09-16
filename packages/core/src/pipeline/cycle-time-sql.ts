import { type SQL, sql } from 'drizzle-orm';
import { activityLog, issues } from '../db/schema.js';

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
