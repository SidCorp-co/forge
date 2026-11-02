/**
 * What a project's master holds beyond its role outside `strict` (REQ-79 r6 BC-11, BC-17; owner ruling
 * 2026-10-31): agents decide and implement by default, so the acts a project's control asked of an
 * admin or an approver are its master's too, unless the project asked for control. The approvals it
 * holds are a grant on its facts (`MASTER_GRANTS`), read wherever the facts are; the release cut and
 * record, which ask project.admin, it holds by that one act (`requireMasterAct`), never project.admin. The master is an
 * agent's credential that writes the project: an agent account's own token, or a paired box's, whose
 * checkout acts as the project's own agent (`devices/workspace-credential.ts:workspaceHolderFor`). It is
 * read off the credential, never a user id; a person's token holds only what its role and grant hold.
 *
 * Under strict nothing is added: the act asks its own permission exactly as it did. Who acted stays
 * recorded as an agent's by each door, from the same agency.
 */

import type { GateProfile } from '@forge/contracts/gate-profiles';
import type {
  ActorAgency,
  PermissionRefusal,
  ProjectPermission,
} from '@forge/contracts/permissions';
import { RefusalError } from '../lib/refusal.js';
import { forbidden } from '../middleware/route-errors.js';
import { holds, type PermissionFacts, permissionFactsOf, permissionRefusal } from './can.js';
import { permissionsPort } from './ports.js';

/**
 * The approvals the master holds outside strict: triaging its project's feedback, agreeing and
 * signing off its requirements, approving its workflow designs and its own contracts (REQ-79 r6 BC-11).
 * A token still narrows them as it narrows any approval (`TOKEN_EXPLICIT_PERMISSIONS`).
 */
export const MASTER_GRANTS: readonly ProjectPermission[] = [
  'feedback.approve',
  'requirements.approve',
  'workflow-designs.approve',
  'contracts.approve',
];

/** Who is asking, and on a project of what profile (`project-config:readGateProfile`). */
export interface MasterAsk {
  agency: ActorAgency;
  profile: GateProfile;
}

/**
 * Whether the credential is the project's master, whatever the project's profile: an agent's that
 * writes it. What it holds beyond its role is `actsAsMaster`'s; who it acts for is the caller's.
 */
export function isMasterCredential(facts: PermissionFacts, agency: ActorAgency): boolean {
  return agency === 'agent' && holds(facts, 'project.write');
}

/** Whether the caller acts as the project's master on a project that is not strict. */
export function actsAsMaster(facts: PermissionFacts, ask: MasterAsk): boolean {
  return ask.profile !== 'strict' && isMasterCredential(facts, ask.agency);
}

/**
 * The refusal an act the master holds outside strict answers: null where its own permission is held,
 * or where the caller is the master on a project that is not strict; else the permission's refusal,
 * saying who else holds it here.
 */
export function masterActRefusal(
  facts: PermissionFacts,
  permission: ProjectPermission,
  ask: MasterAsk,
  act?: string,
): PermissionRefusal | null {
  const refusal = permissionRefusal(facts, permission, act);
  if (refusal === null || actsAsMaster(facts, ask)) return null;
  const why =
    ask.profile === 'strict'
      ? 'This project is strict (gates.profile), so its master holds nothing beyond its role.'
      : "Outside strict the project's master holds it too: an agent's token, or a paired box's, that writes the project.";
  return { ...refusal, detail: `${refusal.detail} ${why}` };
}

/** Throw unless the act is held, as `requireHeld` throws: 403 with no role, else the refusal. */
export function requireMasterAct(
  facts: PermissionFacts,
  permission: ProjectPermission,
  ask: MasterAsk,
  act?: string,
): void {
  if (facts.role === null) {
    throw forbidden(
      `not a member of this project: ${act ? `${act} needs` : 'this needs'} ${permission} on project ${facts.projectId}, which only a member of it holds`,
    );
  }
  const refusal = masterActRefusal(facts, permission, ask, act);
  if (refusal) throw new RefusalError([refusal], refusal.code);
}

/** The facts with the master's grant added where the caller acts as the project's master. */
export function masterFacts(facts: PermissionFacts, ask: MasterAsk): PermissionFacts {
  if (!actsAsMaster(facts, ask)) return facts;
  return { ...facts, grants: [...new Set([...facts.grants, ...MASTER_GRANTS])] };
}

/** `permissionFactsOf` for an actor of this agency, the master's grant read in. */
export async function masterFactsOf(
  userId: string | null | undefined,
  projectId: string,
  agency: ActorAgency,
): Promise<PermissionFacts> {
  const facts = await permissionFactsOf(userId, projectId);
  if (agency !== 'agent' || facts.role === null) return facts;
  const profile = await permissionsPort('gateProfileOf')(projectId);
  return masterFacts(facts, { agency, profile });
}
