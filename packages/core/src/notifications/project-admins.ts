// The people a "needs a human decision" notification must reach.

import { and, eq, inArray } from 'drizzle-orm';
import { db } from '../db/client.js';
import { organizationMembers, projectMembers, projects } from '../db/schema.js';

/**
 * The admin set for many projects in three queries rather than three per project.
 *
 * ISS-1021 — the sweep passes that call this ran it once per ROW: 14 strands across 6 projects
 * and 60 owed closes across 15 asked the database 222 times a minute for 21 distinct answers.
 * The rule is unchanged and lives here once; only the number of round trips moved.
 *
 * Every id asked for is a key in the result, mapping to the empty array where the project has no
 * admin or does not exist — a caller distinguishing "no admins" from "not asked" can do so, and
 * one that cannot is not silently handed the wrong set.
 */
export async function projectAdminUserIdsFor(
  projectIds: readonly string[],
): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>();
  const ids = [...new Set(projectIds)];
  if (ids.length === 0) return out;
  for (const id of ids) out.set(id, []);

  const projectRows = await db
    .select({ id: projects.id, orgId: projects.orgId })
    .from(projects)
    .where(inArray(projects.id, ids));
  if (projectRows.length === 0) return out;

  const orgIds = [...new Set(projectRows.map((r) => r.orgId))];

  const [explicitAdmins, orgAdmins] = await Promise.all([
    db
      .select({ projectId: projectMembers.projectId, userId: projectMembers.userId })
      .from(projectMembers)
      .where(and(inArray(projectMembers.projectId, ids), eq(projectMembers.role, 'admin'))),
    db
      .select({ orgId: organizationMembers.orgId, userId: organizationMembers.userId })
      .from(organizationMembers)
      .where(
        and(
          inArray(organizationMembers.orgId, orgIds),
          inArray(organizationMembers.role, ['owner', 'admin']),
        ),
      ),
  ]);

  const explicitByProject = new Map<string, string[]>();
  for (const row of explicitAdmins) {
    const bucket = explicitByProject.get(row.projectId) ?? [];
    bucket.push(row.userId);
    explicitByProject.set(row.projectId, bucket);
  }
  const orgAdminsByOrg = new Map<string, string[]>();
  for (const row of orgAdmins) {
    const bucket = orgAdminsByOrg.get(row.orgId) ?? [];
    bucket.push(row.userId);
    orgAdminsByOrg.set(row.orgId, bucket);
  }

  for (const project of projectRows) {
    out.set(project.id, [
      ...new Set([
        ...(explicitByProject.get(project.id) ?? []),
        ...(orgAdminsByOrg.get(project.orgId) ?? []),
      ]),
    ]);
  }
  return out;
}

export async function projectAdminUserIds(projectId: string): Promise<string[]> {
  const byProject = await projectAdminUserIdsFor([projectId]);
  return byProject.get(projectId) ?? [];
}
