import { and, eq, inArray, isNotNull, or } from 'drizzle-orm';
import type { Tx } from '../db/client.js';
import { organizationMembers, projectMembers, projects, users } from '../db/schema.js';

/**
 * Whether a human who reads this project's records reads code: a project member, or an owner or
 * admin of its organization, holding the `technical` lens.
 */
export async function readsTechnical(projectId: string, tx: Tx): Promise<boolean> {
  const [project] = await tx
    .select({ orgId: projects.orgId })
    .from(projects)
    .where(eq(projects.id, projectId))
    .limit(1);
  if (!project?.orgId) return false;
  const rows = await tx
    .select({ lenses: organizationMembers.lenses })
    .from(organizationMembers)
    .innerJoin(users, eq(users.id, organizationMembers.userId))
    .leftJoin(
      projectMembers,
      and(
        eq(projectMembers.projectId, projectId),
        eq(projectMembers.userId, organizationMembers.userId),
      ),
    )
    .where(
      and(
        eq(organizationMembers.orgId, project.orgId),
        eq(users.kind, 'human'),
        or(isNotNull(projectMembers.userId), inArray(organizationMembers.role, ['owner', 'admin'])),
      ),
    );
  return rows.some((r) => ((r.lenses ?? []) as string[]).includes('technical'));
}
