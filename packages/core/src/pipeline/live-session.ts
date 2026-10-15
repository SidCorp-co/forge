/**
 * What makes an agent session live: not a chat, and not at a terminal status. The session list and
 * every count that says "live" read this one condition, so no count disagrees with the list.
 */

import { type SQL, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { terminalAgentSessionStatuses } from '../db/schema.js';

export const liveSessionWhere: SQL = sql`s.kind <> 'chat' AND s.status NOT IN (${sql.join(
  terminalAgentSessionStatuses.map((v) => sql`${v}`),
  sql`, `,
)})`;

export type LiveSessionCountRow = { projectId: string; n: number };

/** Live sessions per project, for the projects named; a project with none has no row. */
export function readLiveSessionCounts(projectIds: string[]): Promise<LiveSessionCountRow[]> {
  return db.execute(sql`
    SELECT s.project_id AS "projectId", count(*)::int AS n
      FROM agent_sessions s
     WHERE s.project_id IN (${sql.join(
       projectIds.map((id) => sql`${id}::uuid`),
       sql`, `,
     )})
       AND ${liveSessionWhere}
     GROUP BY s.project_id
  `) as unknown as Promise<LiveSessionCountRow[]>;
}
