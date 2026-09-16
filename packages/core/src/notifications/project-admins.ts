// The people a "needs a human decision" notification must reach.

import { and, eq, inArray } from 'drizzle-orm';
import { db } from '../db/client.js';
import { organizationMembers, projectMembers, projects } from '../db/schema.js';

export async function projectAdminUserIds(projectId: string): Promise<string[]> {
  const [project] = await db
    .select({ orgId: projects.orgId })
    .from(projects)
    .where(eq(projects.id, projectId))
    .limit(1);
  if (!project) return [];

  const [explicitAdmins, orgAdmins] = await Promise.all([
    db
      .select({ userId: projectMembers.userId })
      .from(projectMembers)
      .where(and(eq(projectMembers.projectId, projectId), eq(projectMembers.role, 'admin'))),
    db
      .select({ userId: organizationMembers.userId })
      .from(organizationMembers)
      .where(
        and(
          eq(organizationMembers.orgId, project.orgId),
          inArray(organizationMembers.role, ['owner', 'admin']),
        ),
      ),
  ]);

  return [...new Set([...explicitAdmins.map((r) => r.userId), ...orgAdmins.map((r) => r.userId)])];
}
