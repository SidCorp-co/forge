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
  /** Their role in the organization the project belongs to. */
  projectOrgRole: OrgMemberRole | null;
  orgRoles: ReadonlyMap<string, OrgMemberRole>;
}

export const WHO_CHANGES = 'an admin of this project';
const WHO_GRANTS_A_BOX = "an owner or admin of this project's organization";

export async function bindingReaderOf(
  userId: string,
  projectId: string,
  role: ProjectRole,
): Promise<BindingReader> {
  const [access, orgRoles] = await Promise.all([
    effectiveProjectRole(userId, projectId),
    orgRolesOf(userId),
  ]);
  return { userId, role, projectOrgRole: access?.orgRole ?? null, orgRoles };
}

export function bindingActs(
  reader: BindingReader,
  connection: { ownerType: 'user' | 'org'; ownerId: string },
  provider: string,
): BindingActs {
  const change = reader.role === 'admin';
  const turnOn = managesConnection(connection, reader.userId, reader.orgRoles);
  // A person's connection takes a key from any admin of a project bound to it (ISS-1115).
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
    whoGrantsAgents: boxGrant ? WHO_GRANTS_A_BOX : WHO_CHANGES,
  };
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
