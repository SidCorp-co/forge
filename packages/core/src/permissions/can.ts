/**
 * The one permission check (pattern v2 BC-20, ADR 0007): every who-may-act decision in core asks
 * `can(actor, permission, scope)` or one of its forms below, and nothing else reads a role, a grant
 * or a token for that purpose. Agency and authorship are never read.
 *
 * A project permission is held when the actor's effective role holds it
 * (`@forge/contracts/permissions:ROLE_PERMISSIONS`) or its membership's grant names it, and the
 * token the request arrived on admits it: a write needs the token's `write` scope, and a permission
 * in `TOKEN_EXPLICIT_PERMISSIONS` needs the token's grant to name it.
 */

import {
  ORG_ROLE_PERMISSIONS,
  type OrgPermission,
  type Permission,
  type PermissionRefusal,
  type PermissionScope,
  type ProjectPermission,
  PROJECT_ROLES,
  permissionVerb,
  ROLE_PERMISSIONS,
  TOKEN_EXPLICIT_PERMISSIONS,
} from '@forge/contracts/permissions';
import { eq } from 'drizzle-orm';
import { HTTPException } from 'hono/http-exception';
import { currentPatScope } from '../auth/pat-scope.js';
import { db } from '../db/client.js';
import { type OrgMemberRole, organizations } from '../db/schema.js';
import {
  effectiveProjectRole,
  loadOrgRole,
  loadProjectAccess,
  type ProjectAccess,
} from '../lib/authz.js';
import { RefusalError } from '../lib/refusal.js';

/** What a project decision reads: the effective role and the membership's grant. */
export type PermissionFacts = Pick<ProjectAccess, 'projectId' | 'role' | 'grants'>;

export interface PermissionActor {
  userId: string | null | undefined;
}

const isExplicit = (permission: Permission) => TOKEN_EXPLICIT_PERMISSIONS.includes(permission);

function tokenAdmits(permission: Permission): boolean {
  const token = currentPatScope();
  if (!token) return true;
  if (permissionVerb(permission) !== 'read' && token.scopes && !token.scopes.includes('write')) {
    return false;
  }
  if (isExplicit(permission)) return token.grant?.includes(permission) ?? false;
  return true;
}

export function holds(facts: PermissionFacts, permission: ProjectPermission): boolean {
  if (facts.role === null) return false;
  const held =
    ROLE_PERMISSIONS[facts.role].includes(permission) || facts.grants.includes(permission);
  return held && tokenAdmits(permission);
}

export function holdsOrg(role: OrgMemberRole | null, permission: OrgPermission): boolean {
  if (role === null) return false;
  return ORG_ROLE_PERMISSIONS[role].includes(permission) && tokenAdmits(permission);
}

/** Every project permission the facts hold, for a read that reports what its viewer may do. */
export function heldPermissions(facts: PermissionFacts): ProjectPermission[] {
  if (facts.role === null) return [];
  const all = new Set<ProjectPermission>(ROLE_PERMISSIONS[facts.role]);
  for (const g of facts.grants) all.add(g as ProjectPermission);
  return [...all].filter((p) => holds(facts, p));
}

const rolesHolding = (permission: ProjectPermission) =>
  PROJECT_ROLES.filter((r) => ROLE_PERMISSIONS[r].includes(permission));

export function permissionRefusal(
  facts: PermissionFacts,
  permission: ProjectPermission,
  act?: string,
): PermissionRefusal | null {
  if (holds(facts, permission)) return null;
  const held = facts.role ?? 'no role';
  const grant = facts.grants.length > 0 ? ` and a grant of ${facts.grants.join(', ')}` : '';
  const holders = rolesHolding(permission);
  const by = holders.length > 0 ? `the ${holders.join(' or ')} role or ` : '';
  const token =
    currentPatScope() && isExplicit(permission)
      ? ` A token holds ${permission} only where its own grant names it.`
      : '';
  return {
    code: 'PERMISSION_FORBIDDEN',
    path: '',
    detail: `${act ? `${act} needs` : 'This needs'} ${permission} on project ${facts.projectId}; the caller holds ${held}${grant} there, and ${permission} is held by ${by}a membership grant naming it (an org owner or admin holds admin on every project of the org).${token}`,
    permission,
    scope: { kind: 'project', id: facts.projectId },
  };
}

function orgRefusal(
  orgId: string,
  role: OrgMemberRole,
  permission: OrgPermission,
): PermissionRefusal {
  return {
    code: 'PERMISSION_FORBIDDEN',
    path: '',
    detail: `This needs ${permission} on organization ${orgId}; the caller is an org ${role} there.`,
    permission,
    scope: { kind: 'org', id: orgId },
  };
}

const noAccess = (what: string) =>
  new HTTPException(403, { message: `not a member of this ${what}`, cause: { code: 'FORBIDDEN' } });

/** Throw unless the resolved access holds the permission: 403 with no role at all, else the 422 refusal. */
export function requireHeld(
  access: PermissionFacts,
  permission: ProjectPermission,
  act?: string,
): void {
  if (access.role === null) throw noAccess('project');
  const refusal = permissionRefusal(access, permission, act);
  if (refusal) throw new RefusalError([refusal], refusal.code);
}

/** Resolve the actor's access to the project (404 when it does not exist) and require the permission. */
export async function requireCan(
  actor: PermissionActor,
  permission: ProjectPermission,
  projectId: string,
  act?: string,
): Promise<ProjectAccess> {
  const access = await loadProjectAccess(projectId, actor.userId);
  requireHeld(access, permission, act);
  return access;
}

export function requireOrgHeld(
  orgId: string,
  role: OrgMemberRole | null,
  permission: OrgPermission,
): asserts role is OrgMemberRole {
  if (role === null) throw noAccess('organization');
  if (!holdsOrg(role, permission)) {
    const refusal = orgRefusal(orgId, role, permission);
    throw new RefusalError([refusal], refusal.code);
  }
}

/** Resolve the org (404 when it does not exist) and require the permission there. */
export async function requireOrgCan(
  actor: PermissionActor,
  permission: OrgPermission,
  orgId: string,
): Promise<{ orgId: string; role: OrgMemberRole; isPersonal: boolean }> {
  const [org] = await db
    .select({ id: organizations.id, isPersonal: organizations.isPersonal })
    .from(organizations)
    .where(eq(organizations.id, orgId))
    .limit(1);
  if (!org) {
    throw new HTTPException(404, {
      message: 'organization not found',
      cause: { code: 'NOT_FOUND' },
    });
  }
  const role = await loadOrgRole(orgId, actor.userId);
  requireOrgHeld(orgId, role, permission);
  return { orgId, role, isPersonal: org.isPersonal };
}

/** The question itself, for a caller that only needs the answer. */
export async function can(
  actor: PermissionActor,
  permission: ProjectPermission,
  scope: { kind: 'project'; id: string },
): Promise<boolean>;
export async function can(
  actor: PermissionActor,
  permission: OrgPermission,
  scope: { kind: 'org'; id: string },
): Promise<boolean>;
export async function can(
  actor: PermissionActor,
  permission: Permission,
  scope: PermissionScope,
): Promise<boolean> {
  if (scope.kind === 'org') {
    return holdsOrg(await loadOrgRole(scope.id, actor.userId), permission as OrgPermission);
  }
  const access = await effectiveProjectRole(actor.userId, scope.id);
  return access ? holds(access, permission as ProjectPermission) : false;
}

/** The refusal a write answers, reading the actor's access first; null when the permission is held. */
export async function permissionRefusalFor(
  actor: PermissionActor,
  projectId: string,
  permission: ProjectPermission,
  act?: string,
): Promise<PermissionRefusal | null> {
  return permissionRefusal(await permissionFactsOf(actor.userId, projectId), permission, act);
}

export async function permissionFactsOf(
  userId: string | null | undefined,
  projectId: string,
): Promise<PermissionFacts> {
  const access = await effectiveProjectRole(userId, projectId);
  return { projectId, role: access?.role ?? null, grants: access?.grants ?? [] };
}
