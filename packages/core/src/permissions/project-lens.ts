import { and, eq, inArray, isNotNull, or } from 'drizzle-orm';
import type { Tx } from '../db/client.js';
import { organizationMembers, projectMembers } from '../db/schema.js';
import { projectOrgOf } from '../lib/authz.js';
import { permissionsPort } from './ports.js';

/**
 * Whether a human who reads this project's records reads code: a project member, or an owner or
 * admin of its organization, holding the `technical` lens.
 */
export async function readsTechnical(projectId: string, tx: Tx): Promise<boolean> {
  const orgId = await projectOrgOf(projectId, tx);
  if (!orgId) return false;
  const rows = await tx
    .select({ userId: organizationMembers.userId, lenses: organizationMembers.lenses })
    .from(organizationMembers)
    .leftJoin(
      projectMembers,
      and(
        eq(projectMembers.projectId, projectId),
        eq(projectMembers.userId, organizationMembers.userId),
      ),
    )
    .where(
      and(
        eq(organizationMembers.orgId, orgId),
        or(isNotNull(projectMembers.userId), inArray(organizationMembers.role, ['owner', 'admin'])),
      ),
    );
  const technical = rows.filter((r) => ((r.lenses ?? []) as string[]).includes('technical'));
  if (technical.length === 0) return false;
  const agents = await permissionsPort('agentAccountsAmong')(
    technical.map((r) => r.userId),
    tx,
  );
  return technical.some((r) => !agents.has(r.userId));
}
