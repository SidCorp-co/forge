// The people a "needs a human decision" notification must reach.

import { and, eq, inArray } from 'drizzle-orm';
import { db } from '../db/client.js';
import { organizationMembers, projectMembers, projects } from '../db/schema.js';

// cm:guard mirrors effectiveProjectRole's admin rule (lib/authz.ts) — explicit project_members admin UNION org owner/admin — so a gate notification reaches exactly the people authorised to act on it. Widening this without widening authz sends someone a decision they cannot make.
// cm:edge lockstep -> packages/core/src/lib/authz.ts — same admin definition
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
