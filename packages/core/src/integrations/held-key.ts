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

/** Who turns a connection on or off, as a sentence's subject: the people `managesConnection` admits. */
export function whoManages(connection: { ownerType: 'user' | 'org' }): string {
  return connection.ownerType === 'org'
    ? 'an owner or admin of the organization that owns it'
    : 'its owner';
}

/** A binding PATCH also saves a key on a person's connection for an admin of a project bound to it (ISS-1115). */
export function whoSavesKey(connection: { ownerType: 'user' | 'org' }): string {
  return connection.ownerType === 'org'
    ? whoManages(connection)
    : 'its owner or an admin of a project it is shared with';
}

/** "Only …", opening a sentence. */
export const only = (who: string): string => `Only ${who}`;

function managersOf(connection: { ownerType: 'user' | 'org' }): string {
  return only(whoManages(connection));
}

function keySaversOf(connection: { ownerType: 'user' | 'org' }): string {
  return only(whoSavesKey(connection));
}

function byWhoMay(
  may: boolean,
  connection: { ownerType: 'user' | 'org' },
  act: string,
  who = managersOf(connection),
): string {
  return may ? act : `${who} can ${act.charAt(0).toLowerCase()}${act.slice(1)}`;
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
  if (!install) {
    const save = 'Save a new key to turn it back on.';
    return byWhoMay(reader.savesKey, connection, save, keySaversOf(connection));
  }
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
  return `It is shared with no project, so nothing can turn it back on. ${clear}`;
}

/** No act is an agent's: the way back names who takes it. */
const AN_AGENT: RemovedReader = { manages: false, savesKey: false, installsHere: false };

/** A binding an agent called through, and the connection behind it. */
export interface OffPair {
  binding: { active: boolean };
  connection: {
    id: string;
    provider: string;
    ownerType: 'user' | 'org';
    ownerId: string;
    active: boolean;
    secretsEnc: Buffer | null;
  };
}

/**
 * Why a binding an agent called through gives it nothing, and who switches it back on. "Re-enable the
 * connection under Settings → Integrations" was the answer over a removed connection too, which no
 * Enable turns on (ISS-1421 r26).
 */
export async function offBindingWords(
  { binding, connection }: OffPair,
  projectId: string,
): Promise<string> {
  const enabled =
    'an admin of this project can turn it back on with Enabled on its Integrations tab';
  if (connection.active) return `it is turned off for this project, and ${enabled}.`;
  const removed = isRemovedConnection(connection);
  const bound =
    removed && getIntegration(connection.provider)?.noKeyTurnsBackOn
      ? await listBoundProjectOrgs(connection.id)
      : [];
  const why = removed
    ? `the connection behind it was removed and holds no key. ${turnsBackOnFrom(connection, bound, AN_AGENT, projectId)}`
    : `the connection behind it is switched off for every project sharing it. ${byWhoMay(false, connection, 'Turn it back on with Enable on the Integrations page.')}`;
  return binding.active
    ? why
    : `${why} It is turned off for this project as well, and once the connection is on ${enabled}.`;
}
