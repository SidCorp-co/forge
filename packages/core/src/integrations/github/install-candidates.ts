/**
 * Which GitHub Apps a caller could be completing an installation for: the same
 * pair of grants the repository picker reads, for the same reason (ISS-1115).
 * The rows minted before this are owned by an individual, and the admin
 * finishing an install is not necessarily them.
 *
 * Reading them is not authorizing them — the caller is still asserted admin of
 * the resolved binding's project, and the App still answers to its own JWT.
 */

import { and, eq, inArray, or } from 'drizzle-orm';
import { db } from '../../db/client.js';
import {
  integrationBindings,
  integrationConnections,
  organizationMembers,
  projectMembers,
  projects,
} from '../../db/schema.js';
import { type IntegrationConnectionRow, listConnectionsForPrincipalUser } from '../store.js';

/** Org admin and owner are implicit project admins; a plain member is not. */
const ORG_ADMIN_ROLES = ['admin', 'owner'] as const;

async function githubConnectionsOnAdministeredProjects(
  userId: string,
): Promise<IntegrationConnectionRow[]> {
  const bound = await db
    .selectDistinct({ connectionId: integrationBindings.connectionId })
    .from(integrationBindings)
    .innerJoin(projects, eq(projects.id, integrationBindings.projectId))
    .leftJoin(
      projectMembers,
      and(eq(projectMembers.projectId, projects.id), eq(projectMembers.userId, userId)),
    )
    .leftJoin(
      organizationMembers,
      and(eq(organizationMembers.orgId, projects.orgId), eq(organizationMembers.userId, userId)),
    )
    .where(
      and(
        eq(integrationBindings.provider, 'github'),
        or(
          eq(projectMembers.role, 'admin'),
          inArray(organizationMembers.role, [...ORG_ADMIN_ROLES]),
        ),
      ),
    );
  const ids = bound.map((row) => row.connectionId);
  if (ids.length === 0) return [];
  return db
    .select()
    .from(integrationConnections)
    .where(
      and(inArray(integrationConnections.id, ids), eq(integrationConnections.provider, 'github')),
    );
}

export async function listGithubAppsReachableBy(
  userId: string,
): Promise<IntegrationConnectionRow[]> {
  const mine = (await listConnectionsForPrincipalUser(userId)).filter(
    (c) => c.provider === 'github',
  );
  const administered = await githubConnectionsOnAdministeredProjects(userId);
  const byId = new Map<string, IntegrationConnectionRow>();
  for (const connection of [...mine, ...administered]) byId.set(connection.id, connection);
  return [...byId.values()];
}
