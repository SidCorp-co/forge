import { and, eq, sql } from 'drizzle-orm';
import { HTTPException } from 'hono/http-exception';
import { db } from '../db/client.js';
import {
  type OrgMemberRole,
  type ProjectMemberRole,
  organizationMembers,
  organizations,
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
 */
export async function effectiveProjectRole(
  userId: string,
  projectId: string,
): Promise<ProjectAccess | null> {
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
  userId: string,
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
  userId: string,
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

export async function loadOrgRole(orgId: string, userId: string): Promise<OrgMemberRole | null> {
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
  userId: string,
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
 * Every project id the user can see: explicit project membership (any role,
 * incl. viewer) OR org owner/admin on the project's org. Plain org `member`
 * does not surface the org's projects. Single source for REST project lists,
 * MCP visible-project scoping, and analytics.
 */
export async function loadVisibleProjectIds(userId: string): Promise<string[]> {
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
    .where(
      sql`${projectMembers.userId} IS NOT NULL OR ${organizationMembers.role} IN ('owner', 'admin')`,
    );
  return rows.map((r) => r.id);
}

/** The user's personal org (auto-created at signup / by migration 0106). */
export async function loadPersonalOrgId(userId: string): Promise<string | null> {
  const [row] = await db
    .select({ id: organizations.id })
    .from(organizations)
    .where(and(eq(organizations.createdBy, userId), eq(organizations.isPersonal, true)))
    .limit(1);
  return row?.id ?? null;
}
