/**
 * Which GitHub Apps a caller could be completing an installation for: the same
 * pair of grants the repository picker reads, for the same reason (ISS-1115).
 * The rows minted before this are owned by an individual, and the admin
 * finishing an install is not necessarily them.
 *
 * The door decides which projects the caller administers (permissions/can) and
 * hands only those in; this adapter never reads a role. Reading the Apps is not
 * authorizing them — the caller is still asserted admin of the resolved
 * binding's project, and the App still answers to its own JWT.
 */

import { and, eq, inArray } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { integrationBindings, integrationConnections } from '../../db/schema.js';
import { type IntegrationConnectionRow, listConnectionsForPrincipalUser } from '../index.js';

/** The caller, and the projects the door found it may administer. */
export interface InstallCandidateScope {
  userId: string;
  administeredProjectIds: readonly string[];
}

async function githubConnectionsBoundTo(
  projectIds: readonly string[],
): Promise<IntegrationConnectionRow[]> {
  if (projectIds.length === 0) return [];
  const bound = await db
    .selectDistinct({ connectionId: integrationBindings.connectionId })
    .from(integrationBindings)
    .where(
      and(
        eq(integrationBindings.provider, 'github'),
        inArray(integrationBindings.projectId, [...projectIds]),
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
  scope: InstallCandidateScope,
): Promise<IntegrationConnectionRow[]> {
  const mine = (await listConnectionsForPrincipalUser(scope.userId)).filter(
    (c) => c.provider === 'github',
  );
  const administered = await githubConnectionsBoundTo(scope.administeredProjectIds);
  const byId = new Map<string, IntegrationConnectionRow>();
  for (const connection of [...mine, ...administered]) byId.set(connection.id, connection);
  return [...byId.values()];
}
