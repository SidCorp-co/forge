import { eq } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { organizations, projects } from '../../db/schema.js';

/** The project facts a GitHub App connect names: its slug, name, org and whether that org is personal. */
export async function connectProjectOf(projectId: string) {
  const [project] = await db
    .select({
      slug: projects.slug,
      name: projects.name,
      orgId: projects.orgId,
      orgIsPersonal: organizations.isPersonal,
    })
    .from(projects)
    .innerJoin(organizations, eq(organizations.id, projects.orgId))
    .where(eq(projects.id, projectId))
    .limit(1);
  return project ?? null;
}
