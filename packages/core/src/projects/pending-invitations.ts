import { and, eq, gt, isNull, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import {
  organizations,
  orgInvitations,
  projectInvitations,
  projects,
  users,
} from '../db/schema.js';
import { personNameSql } from '../lib/person-name.js';

/**
 * The invitations a person may still accept, project and organization alike: the rows the bell offers
 * with Accept and Decline. The pending route lists them and the bell's open count counts them, from
 * this one read, so the badge never counts an invitation the panel does not offer (ISS-1229 r14).
 */
export interface PendingInvitation {
  kind: 'project' | 'org';
  token: string;
  name: string;
  /** What the bell calls the inviter: never their address (ISS-1229 r18). */
  inviterName: string;
  role: string;
  expiresAt: Date;
  createdAt: Date;
  /** The project a project invitation is to; null for an organization's. */
  projectId: string | null;
}

/** Null where the user no longer exists, which the caller refuses in its own words. */
export async function readPendingInvitations(
  userId: string,
  now: Date = new Date(),
): Promise<PendingInvitation[] | null> {
  const [user] = await db
    .select({ email: users.email })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  if (!user) return null;

  const projectRows = await db
    .select({
      token: projectInvitations.token,
      name: projects.name,
      inviterName: personNameSql(sql`${users.displayName}`, 'start'),
      role: projectInvitations.role,
      expiresAt: projectInvitations.expiresAt,
      createdAt: projectInvitations.createdAt,
      projectId: projectInvitations.projectId,
    })
    .from(projectInvitations)
    .innerJoin(projects, eq(projects.id, projectInvitations.projectId))
    .innerJoin(users, eq(users.id, projectInvitations.inviterId))
    .where(
      and(
        sql`lower(${projectInvitations.email}) = lower(${user.email})`,
        isNull(projectInvitations.acceptedAt),
        isNull(projectInvitations.dismissedAt),
        gt(projectInvitations.expiresAt, now),
        // An archived project's page answers not found, so it is no invitation to offer (ISS-1229 r15).
        isNull(projects.archivedAt),
      ),
    );

  const orgRows = await db
    .select({
      token: orgInvitations.token,
      name: organizations.name,
      inviterName: personNameSql(sql`${users.displayName}`, 'start'),
      role: orgInvitations.role,
      expiresAt: orgInvitations.expiresAt,
      createdAt: orgInvitations.createdAt,
    })
    .from(orgInvitations)
    .innerJoin(organizations, eq(organizations.id, orgInvitations.orgId))
    .innerJoin(users, eq(users.id, orgInvitations.inviterId))
    .where(
      and(
        sql`lower(${orgInvitations.email}) = lower(${user.email})`,
        isNull(orgInvitations.acceptedAt),
        isNull(orgInvitations.dismissedAt),
        gt(orgInvitations.expiresAt, now),
      ),
    );

  return [
    ...projectRows.map((r) => ({ kind: 'project' as const, ...r })),
    ...orgRows.map((r) => ({ kind: 'org' as const, ...r, projectId: null })),
  ].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
}
