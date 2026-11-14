import { and, eq, inArray, isNull } from 'drizzle-orm';
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

/** The ids among `projectIds` whose project is not archived: an archived project counts in no pulse (ISS-1216's rule). */
export async function unarchivedProjectIds(projectIds: string[]): Promise<string[]> {
  if (projectIds.length === 0) return [];
  const rows = await db
    .select({ id: projects.id })
    .from(projects)
    .where(and(inArray(projects.id, projectIds), isNull(projects.archivedAt)));
  return rows.map((r) => r.id);
}
