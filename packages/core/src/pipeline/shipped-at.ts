import { type SQL, sql } from 'drizzle-orm';

export const SHIPPED_STATUSES = ['closed', 'released', 'awaiting_release'] as const;

const shippedTransition = (alias: string) => sql`
  ${sql.raw(alias)}.action = 'issue.statusChanged'
  AND ${sql.raw(alias)}.payload ->> 'to' IN (${sql.join(
    SHIPPED_STATUSES.map((s) => sql`${s}`),
    sql`, `,
  )})`;

export interface FirstShippedWindow {
  projectIds: readonly string[] | null;
  from: SQL;
  until?: SQL;
}

/**
 * One row per issue whose FIRST shipped transition ever falls in `[from, until)`, over `projectIds`
 * or every project when null. First rather than last, so a day's figure never moves (ISS-1270).
 */
export function firstShipped(window: FirstShippedWindow): SQL {
  const scope =
    window.projectIds === null
      ? sql``
      : sql`AND i.project_id IN (${sql.join(
          window.projectIds.map((id) => sql`${id}::uuid`),
          sql`, `,
        )})`;
  const upper = window.until ? sql`AND al.created_at < ${window.until}` : sql``;
  return sql`
    SELECT al.issue_id, i.project_id, al.created_at AS shipped_at
    FROM activity_log al
    JOIN issues i ON i.id = al.issue_id
    WHERE ${shippedTransition('al')}
      AND al.created_at >= ${window.from}
      ${upper}
      ${scope}
      AND NOT EXISTS (
        SELECT 1 FROM activity_log earlier
        WHERE earlier.issue_id = al.issue_id
          AND ${shippedTransition('earlier')}
          AND (earlier.created_at, earlier.id) < (al.created_at, al.id)
      )`;
}
