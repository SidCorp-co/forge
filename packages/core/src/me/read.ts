import { and, eq, inArray } from 'drizzle-orm';
import { db } from '../db/client.js';
import { projects } from '../db/schema.js';

/** The ids among `projectIds` that belong to `orgId`. */
export async function projectIdsInOrg(projectIds: string[], orgId: string): Promise<string[]> {
  const rows = await db
    .select({ id: projects.id })
    .from(projects)
    .where(and(inArray(projects.id, projectIds), eq(projects.orgId, orgId)));
  return rows.map((r) => r.id);
}
