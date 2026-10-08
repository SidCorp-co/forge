import { and, eq, gt, inArray, isNull, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import {
  devices,
  labels,
  organizationMembers,
  organizations,
  orgInvitations,
  projectInvitations,
  projectMembers,
  projects,
  runners,
  users,
} from '../db/schema.js';
import { visibleProjectsWhere } from '../lib/authz.js';
import { digestToken } from '../lib/token-digest.js';
import { PROJECT_DETAIL } from './projections.js';

/** A project's id and slug, or null. */
export async function projectHead(projectId: string) {
  const [row] = await db
    .select({ id: projects.id, slug: projects.slug })
    .from(projects)
    .where(eq(projects.id, projectId))
    .limit(1);
  return row ?? null;
}

/** A project's slug, name and org, and whether that org is personal; null when there is none. */
export async function projectOrgHead(projectId: string) {
  const [row] = await db
    .select({
      slug: projects.slug,
      name: projects.name,
      orgId: projects.orgId,
      orgIsPersonal: organizations.isPersonal,
    })
    .from(projects)
    .innerJoin(organizations, eq(organizations.id, projects.orgId))
    .where(eq(projects.id, projectId))
    .limit(1);
  return row ?? null;
}

/** The name of a project, or null. */
/** Who created the project: the account a system-authored act is attributed to. */
export async function projectCreatorOf(projectId: string): Promise<string | null> {
  const [row] = await db
    .select({ createdBy: projects.createdBy })
    .from(projects)
    .where(eq(projects.id, projectId))
    .limit(1);
  return row?.createdBy ?? null;
}

export async function projectName(projectId: string): Promise<string | null> {
  const [row] = await db
    .select({ name: projects.name })
    .from(projects)
    .where(eq(projects.id, projectId))
    .limit(1);
  return row?.name ?? null;
}

/** Id, slug, name and active issue prefix of every project in this project's organization, itself included. */
export async function orgSiblingProjects(projectId: string) {
  const org = db.select({ orgId: projects.orgId }).from(projects).where(eq(projects.id, projectId));
  return db
    .select({
      id: projects.id,
      slug: projects.slug,
      name: projects.name,
      issuePrefix: projects.issuePrefix,
    })
    .from(projects)
    .where(inArray(projects.orgId, org));
}

/** Id, slug and name of each of these projects. */
export async function listProjectHeads(projectIds: readonly string[]) {
  return db
    .select({ id: projects.id, slug: projects.slug, name: projects.name })
    .from(projects)
    .where(inArray(projects.id, [...projectIds]));
}

/**
 * Every project `userId` sees (explicit membership or org owner/admin), one row each with the
 * caller's membership and org roles, ordered by id.
 */
export async function listVisibleProjectRows(userId: string, includeArchived: boolean) {
  return (
    db
      .selectDistinctOn([projects.id], {
        id: projects.id,
        slug: projects.slug,
        name: projects.name,
        orgId: projects.orgId,
        orgName: organizations.name,
        orgIsPersonal: organizations.isPersonal,
        createdBy: projects.createdBy,
        memberRole: projectMembers.role,
        orgRole: organizationMembers.role,
        issuePrefix: projects.issuePrefix,
        archivedAt: projects.archivedAt,
        createdAt: projects.createdAt,
      })
      .from(projects)
      .innerJoin(organizations, eq(organizations.id, projects.orgId))
      .leftJoin(
        projectMembers,
        and(eq(projectMembers.projectId, projects.id), eq(projectMembers.userId, userId)),
      )
      .leftJoin(
        organizationMembers,
        and(eq(organizationMembers.orgId, projects.orgId), eq(organizationMembers.userId, userId)),
      )
      .where(
        and(
          ...visibleProjectsWhere(projects.id),
          ...(includeArchived ? [] : [isNull(projects.archivedAt)]),
        ),
      )
      // DISTINCT ON needs its leading ORDER BY to match the distinct column; without it the order
      // varied run to run and the rail's raw-order fallback (ISS-734) jumped tabs on a refetch.
      .orderBy(projects.id)
  );
}

/** The project detail: its row, members, labels and claude-code device pool; null when gone. */
export async function projectDetail(projectId: string) {
  const [project] = await db
    .select(PROJECT_DETAIL)
    .from(projects)
    .where(eq(projects.id, projectId))
    .limit(1);
  if (!project) return null;

  const members = await db
    .select({ userId: projectMembers.userId, role: projectMembers.role })
    .from(projectMembers)
    .where(eq(projectMembers.projectId, projectId));

  const labelRows = await db
    .select({ id: labels.id, name: labels.name, color: labels.color })
    .from(labels)
    .where(eq(labels.projectId, projectId));

  const devicePool = await db
    .select({
      id: devices.id,
      name: devices.name,
      platform: devices.platform,
      status: devices.status,
      lastSeenAt: devices.lastSeenAt,
      runnerId: runners.id,
    })
    .from(runners)
    .innerJoin(devices, eq(devices.id, runners.deviceId))
    .where(and(eq(runners.projectId, projectId), eq(runners.type, 'claude-code')));

  return { project, members, labels: labelRows, devicePool };
}

/** A project's members with each one's account email, display name and kind. */
export async function listProjectMembers(projectId: string) {
  return db
    .select({
      userId: projectMembers.userId,
      email: users.email,
      displayName: users.displayName,
      kind: users.kind,
      role: projectMembers.role,
      grants: projectMembers.grants,
      createdAt: projectMembers.createdAt,
    })
    .from(projectMembers)
    .innerJoin(users, eq(users.id, projectMembers.userId))
    .where(eq(projectMembers.projectId, projectId));
}

/** The role `userId` holds on the project, or null when they are not a member. */
export async function projectMemberRole(projectId: string, userId: string) {
  const [row] = await db
    .select({ role: projectMembers.role })
    .from(projectMembers)
    .where(and(eq(projectMembers.projectId, projectId), eq(projectMembers.userId, userId)))
    .limit(1);
  return row?.role ?? null;
}

/** The account registered under `email`, or null. */
export async function accountIdByEmail(email: string): Promise<string | null> {
  const [row] = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.email, email))
    .limit(1);
  return row?.id ?? null;
}

/** The project's invitations nobody has accepted yet, each with its inviter's email. */
export async function listPendingProjectInvitations(projectId: string) {
  return db
    .select({
      email: projectInvitations.email,
      role: projectInvitations.role,
      expiresAt: projectInvitations.expiresAt,
      createdAt: projectInvitations.createdAt,
      inviterEmail: users.email,
    })
    .from(projectInvitations)
    .innerJoin(users, eq(users.id, projectInvitations.inviterId))
    .where(and(eq(projectInvitations.projectId, projectId), isNull(projectInvitations.acceptedAt)));
}

/** The live project and org invitations sent to `email`, newest first. */
export async function listPendingInvitationsFor(email: string) {
  const now = new Date();

  const projectRows = await db
    .select({
      ref: projectInvitations.tokenHash,
      name: projects.name,
      inviterEmail: users.email,
      role: projectInvitations.role,
      expiresAt: projectInvitations.expiresAt,
      createdAt: projectInvitations.createdAt,
    })
    .from(projectInvitations)
    .innerJoin(projects, eq(projects.id, projectInvitations.projectId))
    .innerJoin(users, eq(users.id, projectInvitations.inviterId))
    .where(
      and(
        sql`lower(${projectInvitations.email}) = lower(${email})`,
        isNull(projectInvitations.acceptedAt),
        isNull(projectInvitations.dismissedAt),
        gt(projectInvitations.expiresAt, now),
      ),
    );

  const orgRows = await db
    .select({
      ref: orgInvitations.tokenHash,
      name: organizations.name,
      inviterEmail: users.email,
      role: orgInvitations.role,
      expiresAt: orgInvitations.expiresAt,
      createdAt: orgInvitations.createdAt,
    })
    .from(orgInvitations)
    .innerJoin(organizations, eq(organizations.id, orgInvitations.orgId))
    .innerJoin(users, eq(users.id, orgInvitations.inviterId))
    .where(
      and(
        sql`lower(${orgInvitations.email}) = lower(${email})`,
        isNull(orgInvitations.acceptedAt),
        isNull(orgInvitations.dismissedAt),
        gt(orgInvitations.expiresAt, now),
      ),
    );

  return [
    ...projectRows.map((r) => ({ kind: 'project' as const, ...r })),
    ...orgRows.map((r) => ({ kind: 'org' as const, ...r })),
  ].sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
}

/** The project invitation a token names, with the project's name and inviter's email, or null. */
export async function projectInvitationByToken(token: string) {
  const [row] = await db
    .select({
      email: projectInvitations.email,
      role: projectInvitations.role,
      expiresAt: projectInvitations.expiresAt,
      acceptedAt: projectInvitations.acceptedAt,
      projectName: projects.name,
      inviterEmail: users.email,
    })
    .from(projectInvitations)
    .innerJoin(projects, eq(projects.id, projectInvitations.projectId))
    .innerJoin(users, eq(users.id, projectInvitations.inviterId))
    .where(eq(projectInvitations.tokenHash, digestToken(token)))
    .limit(1);
  return row ?? null;
}
