import { and, eq, inArray, type SQL, sql } from 'drizzle-orm';
import { HTTPException } from 'hono/http-exception';
import { fencedProjectIds } from '../auth/pat-scope.js';
import { db } from '../db/client.js';
import {
  type OrgMemberRole,
  organizationMembers,
  organizations,
  type ProjectMemberRole,
  projectMembers,
  projects,
} from '../db/schema.js';

/**
 * Who the caller is on a project or org: the effective role, the membership's grant and the
 * visibility predicates. Whether that holds a permission is decided only by
 * `permissions/can.ts` (pattern v2 BC-20). The role rule:
 *
 *   effective project role = max( explicit project_members.role,
 *                                 org-derived role )
 *
 * where org owner/admin derive project `admin` on every project of their org
 * and org `member` derives NOTHING (plain org membership grants no project
 * access). `projects.created_by` is audit-only and never consulted.
 *
 * Project roles: admin > member > viewer (viewer is read-only).
 * Org roles:     owner > admin > member.
 */

const notFound = (message: string) =>
  new HTTPException(404, { message, cause: { code: 'NOT_FOUND' } });

const PROJECT_ROLE_RANK: Record<ProjectMemberRole, number> = { viewer: 1, member: 2, admin: 3 };

export type ProjectAccess = {
  projectId: string;
  orgId: string;
  /** Effective role (already org-aware). null = no access at all. */
  role: ProjectMemberRole | null;
  /** Caller's role in the project's org. null = not in the org. */
  orgRole: OrgMemberRole | null;
  /** Permissions the membership holds beyond its role. */
  grants: readonly string[];
};

/** Org owner/admin ⇒ implicit project admin; org member ⇒ nothing. */
export function orgDerivedProjectRole(orgRole: OrgMemberRole | null): ProjectMemberRole | null {
  return orgRole === 'owner' || orgRole === 'admin' ? 'admin' : null;
}

export function maxProjectRole(
  a: ProjectMemberRole | null,
  b: ProjectMemberRole | null,
): ProjectMemberRole | null {
  if (a === null) return b;
  if (b === null) return a;
  return PROJECT_ROLE_RANK[a] >= PROJECT_ROLE_RANK[b] ? a : b;
}

/**
 * Non-throwing resolver — the single query behind every gate. Returns null
 * when the project does not exist.
 *
 * `userId` may be absent: `requireUserOrDevice()` leaves it unset for device
 * principals, which must fail CLOSED (role null → 403 at the assert), not
 * crash — postgres-js throws UNDEFINED_VALUE on an undefined bind param.
 */
export async function effectiveProjectRole(
  userId: string | null | undefined,
  projectId: string,
): Promise<ProjectAccess | null> {
  const fence = fencedProjectIds();
  if (fence && !fence.includes(projectId)) return null;
  if (!userId) {
    const [row] = await db
      .select({ orgId: projects.orgId })
      .from(projects)
      .where(eq(projects.id, projectId))
      .limit(1);
    if (!row) return null;
    return { projectId, orgId: row.orgId, role: null, orgRole: null, grants: [] };
  }
  const [row] = await db
    .select({
      orgId: projects.orgId,
      memberRole: projectMembers.role,
      grants: projectMembers.grants,
      orgRole: organizationMembers.role,
    })
    .from(projects)
    .leftJoin(
      projectMembers,
      and(eq(projectMembers.projectId, projects.id), eq(projectMembers.userId, userId)),
    )
    .leftJoin(
      organizationMembers,
      and(eq(organizationMembers.orgId, projects.orgId), eq(organizationMembers.userId, userId)),
    )
    .where(eq(projects.id, projectId))
    .limit(1);
  if (!row) return null;
  return {
    projectId,
    orgId: row.orgId,
    role: maxProjectRole(row.memberRole ?? null, orgDerivedProjectRole(row.orgRole ?? null)),
    orgRole: row.orgRole ?? null,
    grants: row.grants ?? [],
  };
}

/** Throwing variant for REST routes: 404 on missing project. */
export async function loadProjectAccess(
  projectId: string,
  userId: string | null | undefined,
  notFoundMessage = 'project not found',
): Promise<ProjectAccess> {
  const access = await effectiveProjectRole(userId, projectId);
  if (!access) throw notFound(notFoundMessage);
  return access;
}

export async function loadOrgRole(
  orgId: string,
  userId: string | null | undefined,
): Promise<OrgMemberRole | null> {
  if (!userId) return null;
  const [row] = await db
    .select({ role: organizationMembers.role })
    .from(organizationMembers)
    .where(and(eq(organizationMembers.orgId, orgId), eq(organizationMembers.userId, userId)))
    .limit(1);
  return row?.role ?? null;
}

/**
 * The "this user can see this project" predicate, plus the PAT fence, for a
 * query that has already left-joined `projectMembers` and `organizationMembers`
 * on the caller. `and(...)` the result into the WHERE.
 */
export function visibleProjectsWhere(): SQL[] {
  const conditions: SQL[] = [
    sql`(${projectMembers.userId} IS NOT NULL OR ${organizationMembers.role} IN ('owner', 'admin'))`,
  ];
  const fence = fencedProjectIds();
  if (fence) conditions.push(fence.length > 0 ? inArray(projects.id, [...fence]) : sql`false`);
  return conditions;
}

/**
 * The PAT fence for work that belongs to no one project: a token fenced to
 * projects is refused, and only a request carrying its owner's whole reach
 * may go on.
 */
export function assertUnfenced(what: string): void {
  if (fencedProjectIds() === null) return;
  throw new HTTPException(403, {
    message:
      `${what} reaches beyond the projects this token is fenced to, so a fenced token may not ` +
      'do it. Use a token with no project list, or a session.',
    cause: { code: 'PAT_ACCOUNT_ROUTE', details: { action: what } },
  });
}

export async function loadVisibleProjectIds(userId: string | null | undefined): Promise<string[]> {
  if (!userId) return [];
  const rows = await db
    .selectDistinct({ id: projects.id })
    .from(projects)
    .leftJoin(
      projectMembers,
      and(eq(projectMembers.projectId, projects.id), eq(projectMembers.userId, userId)),
    )
    .leftJoin(
      organizationMembers,
      and(eq(organizationMembers.orgId, projects.orgId), eq(organizationMembers.userId, userId)),
    )
    .where(and(...visibleProjectsWhere()));
  return rows.map((r) => r.id);
}

/** The user's personal org (auto-created at signup / by migration 0106). */
export async function loadPersonalOrgId(userId: string | null | undefined): Promise<string | null> {
  if (!userId) return null;
  const [row] = await db
    .select({ id: organizations.id })
    .from(organizations)
    .where(and(eq(organizations.createdBy, userId), eq(organizations.isPersonal, true)))
    .limit(1);
  return row?.id ?? null;
}
