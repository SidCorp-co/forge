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
 * THE authz module. Every project/org permission decision in core — REST,
 * MCP, WS — resolves through here. There is exactly ONE rule:
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

const forbidden = (message: string) =>
  new HTTPException(403, { message, cause: { code: 'FORBIDDEN' } });

const PROJECT_ROLE_RANK: Record<ProjectMemberRole, number> = { viewer: 1, member: 2, admin: 3 };
const ORG_ROLE_RANK: Record<OrgMemberRole, number> = { member: 1, admin: 2, owner: 3 };

export type ProjectAccess = {
  projectId: string;
  orgId: string;
  /** Effective role (already org-aware). null = no access at all. */
  role: ProjectMemberRole | null;
  /** Caller's role in the project's org. null = not in the org. */
  orgRole: OrgMemberRole | null;
};

export function projectRoleAtLeast(
  role: ProjectMemberRole | null,
  min: ProjectMemberRole,
): boolean {
  return role !== null && PROJECT_ROLE_RANK[role] >= PROJECT_ROLE_RANK[min];
}

export function orgRoleAtLeast(role: OrgMemberRole | null, min: OrgMemberRole): boolean {
  return role !== null && ORG_ROLE_RANK[role] >= ORG_ROLE_RANK[min];
}

/** Org owner/admin ⇒ implicit project admin; org member ⇒ nothing. */
export function orgDerivedProjectRole(orgRole: OrgMemberRole | null): ProjectMemberRole | null {
  return orgRoleAtLeast(orgRole, 'admin') ? 'admin' : null;
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
  // cm:guard the fence sits ABOVE the `!userId` branch and returns the same `null` a missing project returns, so `loadProjectAccess` 404s and `assertProjectAccess` 403s exactly as they already do for a project that is not there. Both halves are load-bearing: above, because a fenced request must never reach a query keyed on a project it may not name; and `null` rather than a throw, because a distinct out-of-scope status would turn any PAT into an existence oracle for every project id in the fleet — which is why the MCP side answers NOT_FOUND too.
  const fence = fencedProjectIds();
  if (fence && !fence.includes(projectId)) return null;
  if (!userId) {
    const [row] = await db
      .select({ orgId: projects.orgId })
      .from(projects)
      .where(eq(projects.id, projectId))
      .limit(1);
    if (!row) return null;
    return { projectId, orgId: row.orgId, role: null, orgRole: null };
  }
  const [row] = await db
    .select({
      orgId: projects.orgId,
      memberRole: projectMembers.role,
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

/** 403 unless the effective role is at least `min`. */
export function assertProjectRole(
  access: ProjectAccess,
  min: ProjectMemberRole,
  message?: string,
): void {
  if (!projectRoleAtLeast(access.role, min)) {
    throw forbidden(message ?? `requires project ${min} access`);
  }
}

/**
 * One-shot gate that does NOT leak existence: any failure mode (project
 * missing, no access, role below `min`) throws the same 403. Use on surfaces
 * where a 404-vs-403 distinction would let callers probe project IDs (memory,
 * docs, step-handoffs).
 */
export async function assertProjectAccess(
  projectId: string,
  userId: string | null | undefined,
  min: ProjectMemberRole = 'member',
): Promise<ProjectAccess> {
  const access = await effectiveProjectRole(userId, projectId);
  if (!access || !projectRoleAtLeast(access.role, min)) {
    throw forbidden('not a project member');
  }
  return access;
}

/**
 * Org-tier gate on an already-loaded project access. Replaces the legacy
 * "project owner only" checks: destructive / settings-level project ops
 * (delete, archive, settings PATCH, pipeline-config PATCH) require org
 * owner/admin on the project's org — a project-level `admin` (invited) is
 * NOT enough, mirroring the old owner-vs-admin split.
 */
export function assertOrgRoleOnProject(
  access: ProjectAccess,
  min: OrgMemberRole,
  message?: string,
): void {
  if (!orgRoleAtLeast(access.orgRole, min)) {
    throw forbidden(message ?? `requires org ${min} access`);
  }
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

/** Throwing org gate: 404 when the org is missing, 403 below `min`. */
export async function assertOrgAccess(
  orgId: string,
  userId: string | null | undefined,
  min: OrgMemberRole,
): Promise<{ orgId: string; role: OrgMemberRole; isPersonal: boolean }> {
  const [org] = await db
    .select({ id: organizations.id, isPersonal: organizations.isPersonal })
    .from(organizations)
    .where(eq(organizations.id, orgId))
    .limit(1);
  if (!org) throw notFound('organization not found');
  const role = await loadOrgRole(orgId, userId);
  if (!orgRoleAtLeast(role, min)) {
    throw forbidden(`requires org ${min} access`);
  }
  return { orgId, role: role as OrgMemberRole, isPersonal: org.isPersonal };
}

/**
 * The "this user can see this project" predicate, plus the PAT fence, for a
 * query that has already left-joined `projectMembers` and `organizationMembers`
 * on the caller. `and(...)` the result into the WHERE.
 */
// cm:guard the OR term keeps its OWN parentheses. `and()` joins its operands with ` and ` and wraps the RESULT, but never wraps a raw `sql` operand, so an unparenthesised `a OR b` binds looser than every sibling condition and silently annuls them all: `GET /api/projects` was returning archived projects to any project member on exactly this shape long before a fence was added, and the fence would have been annulled the same way.
// cm:guard the fence is a WHERE term and NOT a post-filter on the rows, because a `LIMIT`/`DISTINCT ON` applied before an in-memory filter returns a short page rather than a fenced one — and every caller here paginates. `projects/routes.ts` inlines the same visibility rule for its own wider projection, which is why this is a shared predicate instead of a private one: measured 2026-09-01, that handler was the one enumeration `loadVisibleProjectIds` did not cover, and it listed every project a scoped token's owner could see.
export function visibleProjectsWhere(): SQL[] {
  const conditions: SQL[] = [
    sql`(${projectMembers.userId} IS NOT NULL OR ${organizationMembers.role} IN ('owner', 'admin'))`,
  ];
  const fence = fencedProjectIds();
  if (fence) conditions.push(fence.length > 0 ? inArray(projects.id, [...fence]) : sql`false`);
  return conditions;
}

/**
 * Every project id the user can see: explicit project membership (any role,
 * incl. viewer) OR org owner/admin on the project's org. Plain org `member`
 * does not surface the org's projects. Single source for REST project lists,
 * MCP visible-project scoping, and analytics.
 */
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
