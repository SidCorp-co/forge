/**
 * A secret saved beside the key after a remove (Rocket.Chat's `userId`) leaves a secrets record
 * holding no key, so a stored record is not a held key (ISS-1421 r22).
 */

import { eq, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { integrationBindings, organizations, projects } from '../db/schema.js';
import { getIntegration } from './registry.js';
import { decryptJson } from './vault.js';

export function keyIn(provider: string, secrets: Record<string, unknown> | null): boolean {
  if (secrets === null) return false;
  const primary = getIntegration(provider)?.schemas.primaryCredentialField;
  if (!primary) return true;
  const key = secrets[primary];
  return typeof key === 'string' && key !== '';
}

/** A record the vault cannot open is not read as holding none. */
export function holdsKey(row: { provider: string; secretsEnc: Buffer | null }): boolean {
  if (row.secretsEnc === null) return false;
  try {
    return keyIn(row.provider, decryptJson<Record<string, unknown>>(row.secretsEnc));
  } catch {
    return true;
  }
}

export function isRemovedConnection(row: {
  provider: string;
  active: boolean;
  secretsEnc: Buffer | null;
}): boolean {
  return !row.active && !holdsKey(row);
}

/** A project a connection is bound to, with the organization an App created from it would belong to. */
export type BoundProject = { projectId: string; orgId: string | null; orgIsPersonal: boolean };

/** The projects a connection is bound to, with the organization each belongs to. */
export async function listBoundProjectOrgs(connectionId: string): Promise<BoundProject[]> {
  return db
    .selectDistinct({
      projectId: integrationBindings.projectId,
      orgId: projects.orgId,
      orgIsPersonal: sql<boolean>`coalesce(${organizations.isPersonal}, true)`,
    })
    .from(integrationBindings)
    .innerJoin(projects, eq(projects.id, integrationBindings.projectId))
    .leftJoin(organizations, eq(organizations.id, projects.orgId))
    .where(eq(integrationBindings.connectionId, connectionId));
}

/** The rule `assertRemovedConnectionTakesTheApp` refuses by: an App goes to the project's org, or to its person. */
export function takesTheApp(
  owner: { ownerType: 'user' | 'org'; ownerId: string },
  project: BoundProject,
): boolean {
  return owner.ownerType === 'org'
    ? !project.orgIsPersonal && project.orgId === owner.ownerId
    : project.orgIsPersonal;
}

/**
 * The way back of a removed connection whose key comes by an install: from a bound project whose App
 * would belong to the connection's owner, which is this one only where it is (ISS-1421 r23).
 */
export function turnsBackOnFrom(
  connection: { provider: string; ownerType: 'user' | 'org'; ownerId: string },
  bound: readonly BoundProject[],
  askedFrom?: string,
): string {
  const install = getIntegration(connection.provider)?.noKeyTurnsBackOn;
  if (!install) return 'Save a new key to turn it back on.';
  const here = bound.find((p) => p.projectId === askedFrom);
  if (here && takesTheApp(connection, here)) return install.fromHere;
  // "None of them" already covers this one, and saying both told the reader twice (ISS-1421 r24).
  if (bound.some((p) => takesTheApp(connection, p))) {
    return here ? `${install.notFromHere} ${install.fromBound}` : install.fromBound;
  }
  if (bound.length > 0) return install.noneTakesIt;
  return 'No project is bound to it, so nothing can turn it back on. Clear it from the list on the Integrations page.';
}
