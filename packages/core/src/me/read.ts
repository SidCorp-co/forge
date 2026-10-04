import { and, desc, eq, inArray } from 'drizzle-orm';
import { db } from '../db/client.js';
import { issues, projects } from '../db/schema.js';
import { issueArchiveSide } from '../issues/archive.js';

/** The ids among `projectIds` that belong to `orgId`. */
export async function projectIdsInOrg(projectIds: string[], orgId: string): Promise<string[]> {
  const rows = await db
    .select({ id: projects.id })
    .from(projects)
    .where(and(inArray(projects.id, projectIds), eq(projects.orgId, orgId)));
  return rows.map((r) => r.id);
}

/** The most recently updated unarchived issues across `projectIds`, with their project. */
export async function readRecentChanges(projectIds: string[], limit: number) {
  const rows = await db
    .select({
      id: issues.id,
      issSeq: issues.issSeq,
      title: issues.title,
      status: issues.status,
      updatedAt: issues.updatedAt,
      projectSlug: projects.slug,
      projectName: projects.name,
    })
    .from(issues)
    .innerJoin(projects, eq(projects.id, issues.projectId))
    .where(and(inArray(issues.projectId, projectIds), ...issueArchiveSide(false)))
    .orderBy(desc(issues.updatedAt))
    .limit(limit);
  return rows.map((r) => ({
    id: r.id,
    issSeq: r.issSeq,
    title: r.title,
    status: r.status,
    updatedAt: r.updatedAt.toISOString(),
    projectSlug: r.projectSlug,
    projectName: r.projectName,
  }));
}
