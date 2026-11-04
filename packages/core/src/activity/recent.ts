// The peek's Recent list (ISS-951, MK-9): the newest things core already recorded on one project —
// its master's passes opened and settled, issues' status moves, merge marks, change requests opened
// and merged, and runs started and ended. Read only when a person opens the list, never by the
// workspace's rows.

import { ORG_ACTIVITY_RECENT_LIMIT, type OrgActivityRecent } from '@forge/contracts/org-activity';
import { sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { readProjectEvents } from './events.js';

const rowsOf = <T>(r: unknown) => [...(r as Iterable<T>)];

/** The name of a live project of the org, or null where the org holds no such project. */
export async function projectOfOrg(orgId: string, projectId: string): Promise<string | null> {
  const [row] = rowsOf<{ name: string }>(
    await db.execute(
      sql`SELECT name FROM projects WHERE id = ${projectId} AND org_id = ${orgId} AND archived_at IS NULL`,
    ),
  );
  return row?.name ?? null;
}

/** The project's newest events, newest first: the workspace's one event read (`events.ts`), unbounded in time. */
export async function readProjectRecent(
  projectId: string,
  limit: number = ORG_ACTIVITY_RECENT_LIMIT,
): Promise<OrgActivityRecent> {
  const events =
    (await readProjectEvents([projectId], { since: null, limit })).get(projectId) ?? [];
  return {
    projectId,
    items: events.slice(0, limit).map(({ span: _span, ...event }) => event),
  };
}
