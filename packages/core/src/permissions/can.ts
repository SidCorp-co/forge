/**
 * The one permission check (pattern v2 BC-20, ADR 0007): every who-may-act decision in core asks
 * `can(actor, permission, resource)` or one of its forms below, and nothing else reads a role, a
 * grant or a token for that purpose. Agency and authorship are never read. A list asks the same
 * question of every row at once through `visibleFilter`.
 *
 * A project permission is held when the actor's effective role holds it
 * (`@forge/contracts/permissions:ROLE_PERMISSIONS`) or its membership's grant names it, and the
 * token the request arrived on admits it: a write needs the token's `write` scope, and a permission
 * in `TOKEN_EXPLICIT_PERMISSIONS` (every approval among them) needs the token's grant to name it.
 * Only the resource's project decides today; its type and id are carried so that per-resource
 * permissions change no call site.
 */

import {
  type OrgPermission,
  type OrgResource,
  ORG_ROLE_PERMISSIONS,
  type Permission,
  type PermissionRefusal,
  PROJECT_ROLES,
  type ProjectPermission,
  type ProjectResource,
  permissionVerb,
  ROLE_PERMISSIONS,
  TOKEN_EXPLICIT_PERMISSIONS,
} from '@forge/contracts/permissions';
import { and, exists, inArray, or, type SQL, type SQLWrapper, sql } from 'drizzle-orm';
import { currentPatScope, fencedProjectIds } from '../credentials/pat-scope.js';
import { db } from '../db/client.js';
import {
  type OrgMemberRole,
  organizationMembers,
  projectMembers,
  projects,
} from '../db/schema.js';
import {
  effectiveProjectRole,
  loadOrgRole,
  loadProjectAccess,
  type ProjectAccess,
} from '../lib/authz.js';
import { RefusalError } from '../lib/refusal.js';
import { forbidden } from '../middleware/route-errors.js';
import type { Actor } from './actor.js';

/** What a project decision reads: the effective role and the membership's grant. */
export type PermissionFacts = Pick<ProjectAccess, 'projectId' | 'role' | 'grants'>;

export type PermissionActor = Actor;

/** A project-wide resource: the project itself, for a check no narrower row answers. */
export const projectResource = (projectId: string): ProjectResource => ({
  type: 'project',
  id: projectId,
  projectId,
});

export const orgResource = (orgId: string): OrgResource => ({ type: 'org', id: orgId });

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

const noAccess = (what: string) => forbidden(`not a member of this ${what}`);

/** Throw unless the resolved access holds the permission: 403 with no role at all, else the 403 refusal. */
export function requireHeld(
  access: PermissionFacts,
  permission: ProjectPermission,
  act?: string,
): void {
  if (access.role === null) throw noAccess('project');
  const refusal = permissionRefusal(access, permission, act);
  if (refusal) throw new RefusalError([refusal], refusal.code);
}

/** Resolve the actor's access to the resource's project (404 when it does not exist) and require the permission. */
export async function requireCan(
  actor: PermissionActor,
  permission: ProjectPermission,
  resource: ProjectResource,
  act?: string,
): Promise<ProjectAccess> {
  const access = await loadProjectAccess(resource.projectId, actor.userId);
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

/**
 * Require the permission on the org. Only the caller's own org membership is read: an org the caller
 * is not in, or one that does not exist, is the same 403.
 */
export async function requireOrgCan(
  actor: PermissionActor,
  permission: OrgPermission,
  resource: OrgResource,
): Promise<{ orgId: string; role: OrgMemberRole }> {
  const role = await loadOrgRole(resource.id, actor.userId);
  requireOrgHeld(resource.id, role, permission);
  return { orgId: resource.id, role };
}

/** The question itself, for a caller that only needs the answer. */
export async function can(
  actor: PermissionActor,
  permission: ProjectPermission,
  resource: ProjectResource,
): Promise<boolean>;
export async function can(
  actor: PermissionActor,
  permission: OrgPermission,
  resource: OrgResource,
): Promise<boolean>;
export async function can(
  actor: PermissionActor,
  permission: Permission,
  resource: ProjectResource | OrgResource,
): Promise<boolean> {
  if (!('projectId' in resource)) {
    return holdsOrg(await loadOrgRole(resource.id, actor.userId), permission as OrgPermission);
  }
  const access = await effectiveProjectRole(actor.userId, resource.projectId);
  return access ? holds(access, permission as ProjectPermission) : false;
}

/**
 * The same question asked of every row of a list at once: a predicate over the rows' project
 * column, true where the actor holds the permission on that project and the request's token
 * admits it. `and(...)` it into the list's WHERE in place of joining `project_members` by hand.
 */
export function visibleFilter(
  actor: PermissionActor,
  permission: ProjectPermission,
  resource: { type: string; projectId: SQLWrapper },
): SQL {
  const userId = actor.userId;
  if (!userId || !tokenAdmits(permission)) return sql`false`;
  const memberRoles = rolesHolding(permission);
  const member = exists(
    db
      .select({ one: sql`1` })
      .from(projectMembers)
      .where(
        and(
          sql`${projectMembers.projectId} = ${resource.projectId}`,
          sql`${projectMembers.userId} = ${userId}`,
          or(
            ...(memberRoles.length > 0 ? [inArray(projectMembers.role, memberRoles)] : []),
            sql`${permission} = ANY(${projectMembers.grants})`,
          ),
        ),
      ),
  );
  const orgAdmin = ROLE_PERMISSIONS.admin.includes(permission)
    ? exists(
        db
          .select({ one: sql`1` })
          .from(projects)
          .innerJoin(organizationMembers, sql`${organizationMembers.orgId} = ${projects.orgId}`)
          .where(
            and(
              sql`${projects.id} = ${resource.projectId}`,
              sql`${organizationMembers.userId} = ${userId}`,
              inArray(organizationMembers.role, ['owner', 'admin']),
            ),
          ),
      )
    : undefined;
  const held = orgAdmin ? (or(member, orgAdmin) as SQL) : member;
  const fence = fencedProjectIds();
  if (fence === null) return held;
  if (fence.length === 0) return sql`false`;
  return and(held, sql`${resource.projectId} IN ${[...fence]}`) as SQL;
}

/** The refusal a write answers, reading the actor's access first; null when the permission is held. */
export async function permissionRefusalFor(
  actor: PermissionActor,
  permission: ProjectPermission,
  resource: ProjectResource,
  act?: string,
): Promise<PermissionRefusal | null> {
  return permissionRefusal(
    await permissionFactsOf(actor.userId, resource.projectId),
    permission,
    act,
  );
}

export async function permissionFactsOf(
  userId: string | null | undefined,
  projectId: string,
): Promise<PermissionFacts> {
  const access = await effectiveProjectRole(userId, projectId);
  return { projectId, role: access?.role ?? null, grants: access?.grants ?? [] };
}
