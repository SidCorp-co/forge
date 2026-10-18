/**
 * A session listed as live is no chat and not ended; a count of live sessions adds the chats whose
 * turn is running, as the dashboard and a box's busy count do (ISS-1228).
 */

import { type SQL, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { terminalAgentSessionStatuses } from '../db/schema.js';

export const liveSessionWhere: SQL = sql`s.kind <> 'chat' AND s.status NOT IN (${sql.join(
  terminalAgentSessionStatuses.map((v) => sql`${v}`),
  sql`, `,
)})`;

export const liveCountWhere: SQL = sql`((${liveSessionWhere}) OR (s.kind = 'chat' AND s.status = 'running'))`;

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
       AND ${liveCountWhere}
     GROUP BY s.project_id
  `) as unknown as Promise<LiveSessionCountRow[]>;
}
