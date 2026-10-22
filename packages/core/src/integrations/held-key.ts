/**
 * A secret saved beside the key after a remove (Rocket.Chat's `userId`) leaves a secrets record
 * holding no key, so a stored record is not a held key (ISS-1421 r22).
 */

import { eq, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { integrationBindings, organizations, projects } from '../db/schema.js';
import { getIntegration } from './registry.js';
import { decryptSecretIfReadable } from './vault.js';

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
  const opened = decryptSecretIfReadable(row.secretsEnc);
  return opened === null || keyIn(row.provider, JSON.parse(opened) as Record<string, unknown>);
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

/** What the asker may do, so a way back offers no act they would be refused (ISS-1421 r25). */
export interface RemovedReader {
  manages: boolean;
  savesKey: boolean;
  installsHere: boolean;
}

/** The connection's own routes admit its managers alone. */
export const MANAGES_IT: RemovedReader = { manages: true, savesKey: true, installsHere: false };

function managersOf(connection: { ownerType: 'user' | 'org' }): string {
  return connection.ownerType === 'org'
    ? 'Only an owner or admin of the organization that owns it'
    : 'Only its owner';
}

function byWhoMay(may: boolean, connection: { ownerType: 'user' | 'org' }, act: string): string {
  return may ? act : `${managersOf(connection)} can ${act.charAt(0).toLowerCase()}${act.slice(1)}`;
}

export function clearIt(connection: { ownerType: 'user' | 'org' }, reader: RemovedReader): string {
  return byWhoMay(reader.manages, connection, 'Clear it from the list on the Integrations page.');
}

/**
 * The way back of a removed connection whose key comes by an install: from a bound project whose App
 * would belong to the connection's owner, which is this one only where it is (ISS-1421 r23).
 */
export function turnsBackOnFrom(
  connection: { provider: string; ownerType: 'user' | 'org'; ownerId: string },
  bound: readonly BoundProject[],
  reader: RemovedReader,
  askedFrom?: string,
): string {
  const install = getIntegration(connection.provider)?.noKeyTurnsBackOn;
  if (!install) return byWhoMay(reader.savesKey, connection, 'Save a new key to turn it back on.');
  const clear = clearIt(connection, reader);
  const here = bound.find((p) => p.projectId === askedFrom);
  if (here && takesTheApp(connection, here)) {
    return byWhoMay(reader.installsHere, connection, install.fromHere);
  }
  // "None of them" already covers this one, and saying both told the reader twice (ISS-1421 r24).
  if (bound.some((p) => takesTheApp(connection, p))) {
    const fromBound = byWhoMay(reader.manages, connection, install.fromBound);
    return here ? `${install.notFromHere} ${fromBound}` : fromBound;
  }
  if (bound.length > 0) return `${install.noneTakesIt} ${clear}`;
  return `No project is bound to it, so nothing can turn it back on. ${clear}`;
}
