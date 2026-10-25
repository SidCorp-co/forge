/**
 * What a reader may do with a project's binding, stated once: the binding doors refuse by it, the
 * project's binding list returns it, and the drawers draw only what it allows. Three rules once
 * answered this apart — `assertAdmin` at the doors, `useOrgConnectionLocked` in the web and
 * `removedReaderOf` in the refusal sentences — and a plain project member was offered acts the
 * doors then refused with a bare "Forbidden." (ISS-1421 r27).
 */

import type { BindingActs, ProjectIntegrationActs } from '@forge/contracts';
import type { OrgMemberRole } from '../db/schema.js';
import { effectiveProjectRole, orgRoleAtLeast } from '../lib/authz.js';
import { agentAccessTier } from './agent-access.js';
import { whoManages, whoSavesKey } from './held-key.js';
import { managesConnection, orgRolesOf } from './reach.js';
import { getIntegration } from './registry.js';

export type ProjectRole = 'admin' | 'member' | 'viewer';

/** A person reading a project's bindings: their role there, and their role in each organization. */
export interface BindingReader {
  userId: string;
  role: ProjectRole;
  /** The organization the project belongs to, and their role in it. */
  projectOrgId: string | null;
  projectOrgRole: OrgMemberRole | null;
  orgRoles: ReadonlyMap<string, OrgMemberRole>;
}

export const WHO_CHANGES = 'an admin of this project';
export const WHO_GRANTS_A_BOX = "an owner or admin of this project's organization";

export async function bindingReaderOf(
  userId: string,
  projectId: string,
  role: ProjectRole,
): Promise<BindingReader> {
  const [access, orgRoles] = await Promise.all([
    effectiveProjectRole(userId, projectId),
    orgRolesOf(userId),
  ]);
  return {
    userId,
    role,
    projectOrgId: access?.orgId ?? null,
    projectOrgRole: access?.orgRole ?? null,
    orgRoles,
  };
}

export function bindingActs(
  reader: BindingReader,
  connection: { ownerType: 'user' | 'org'; ownerId: string },
  provider: string,
): BindingActs {
  const change = reader.role === 'admin';
  const turnOn = managesConnection(connection, reader.userId, reader.orgRoles);
  const saveKey = turnOn || (change && connection.ownerType === 'user');
  const tier = agentAccessTier(getIntegration(provider));
  const boxGrant = tier === 'org-admin';
  const grantAgents =
    change && tier !== 'refused' && (!boxGrant || orgRoleAtLeast(reader.projectOrgRole, 'admin'));
  return {
    change,
    saveKey,
    turnOn,
    grantAgents,
    whoChanges: WHO_CHANGES,
    whoSavesKey: whoSavesKey(connection),
    whoTurnsOn: whoManages(connection),
    // No one may grant a provider that declares no agent path, and the list says so (ISS-1421 r28).
    whoGrantsAgents: tier === 'refused' ? null : boxGrant ? WHO_GRANTS_A_BOX : WHO_CHANGES,
  };
}

/** An act a binding write carries, as `BindingActs` names it. */
export type BindingAct = 'change' | 'grantAgents' | 'saveKey';

/**
 * The people a binding act is open to, as sets one can contain another: an owner or admin of the
 * project's organization is an admin of the project (`orgDerivedProjectRole`), and an admin of a
 * project bound to a person's connection may save its key (ISS-1115).
 */
type People = 'projectAdmins' | 'projectOrgAdmins' | 'connectionOrgAdmins' | 'personKeySavers';

const PEOPLE_WORDS: Record<People, string> = {
  projectAdmins: WHO_CHANGES,
  projectOrgAdmins: WHO_GRANTS_A_BOX,
  connectionOrgAdmins: 'an owner or admin of the organization that owns its connection',
  personKeySavers: "its connection's owner or an admin of a project bound to it",
};

const PEOPLE_ORDER: readonly People[] = [
  'projectAdmins',
  'projectOrgAdmins',
  'connectionOrgAdmins',
  'personKeySavers',
];

function peopleFor(
  act: BindingAct,
  connection: { ownerType: 'user' | 'org'; ownerId: string },
  provider: string,
  projectOrgId: string | null,
): People {
  if (act === 'change') return 'projectAdmins';
  if (act === 'grantAgents') {
    return agentAccessTier(getIntegration(provider)) === 'org-admin'
      ? 'projectOrgAdmins'
      : 'projectAdmins';
  }
  if (connection.ownerType === 'user') return 'personKeySavers';
  return connection.ownerId === projectOrgId ? 'projectOrgAdmins' : 'connectionOrgAdmins';
}

/**
 * Who may take every one of `acts` at once, as a sentence's subject: the smallest of the people
 * each act is open to where one set holds the others, and both named where two do not meet in one
 * role (an organization owning the connection that is not the project's). A request carrying
 * several acts its sender may not take is answered by this, never by its first act (ISS-1421 r28).
 */
export function whoMayAll(
  acts: readonly BindingAct[],
  connection: { ownerType: 'user' | 'org'; ownerId: string },
  provider: string,
  projectOrgId: string | null,
): string {
  const people = new Set(acts.map((a) => peopleFor(a, connection, provider, projectOrgId)));
  const narrower = people.has('projectOrgAdmins') || people.has('projectAdmins');
  if (narrower) people.delete('personKeySavers');
  if (people.has('projectOrgAdmins')) people.delete('projectAdmins');
  const [first, second] = PEOPLE_ORDER.filter((p) => people.has(p)).map((p) => PEOPLE_WORDS[p]);
  if (!first) return WHO_CHANGES;
  return second ? `${first} who is also ${second}` : first;
}

export function projectIntegrationActs(
  reader: Pick<BindingReader, 'role' | 'projectOrgRole'>,
): ProjectIntegrationActs {
  const connect = reader.role === 'admin';
  // The project's settings door asks the same of its reader (`assertOrgRoleOnProject(…, 'admin')`).
  const orgAdmin = orgRoleAtLeast(reader.projectOrgRole, 'admin');
  return {
    connect,
    whoConnects: WHO_CHANGES,
    grantBoxAgents: connect && orgAdmin,
    whoGrantsBoxAgents: WHO_GRANTS_A_BOX,
    changeProjectSettings: orgAdmin,
    whoChangesProjectSettings: WHO_GRANTS_A_BOX,
  };
}
