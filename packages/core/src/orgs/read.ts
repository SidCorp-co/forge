import { and, count, eq, isNull } from 'drizzle-orm';
import { db } from '../db/client.js';
import {
  type OrgMemberRole,
  organizationMembers,
  organizations,
  orgInvitations,
  projects,
  users,
} from '../db/schema.js';
import { readAuthUser } from '../middleware/auth.js';

/** How many projects live in `orgId`. */
export async function orgProjectCount(orgId: string): Promise<number> {
  const [row] = await db.select({ n: count() }).from(projects).where(eq(projects.orgId, orgId));
  return Number(row?.n ?? 0);
}

/** The projects `orgId` holds, name and slug only. */
export async function listOrgProjects(orgId: string) {
  return db
    .select({
      id: projects.id,
      slug: projects.slug,
      name: projects.name,
      archivedAt: projects.archivedAt,
      createdAt: projects.createdAt,
    })
    .from(projects)
    .where(eq(projects.orgId, orgId));
}

/** The account registered under `email`, or null. */
export async function userIdByEmail(email: string): Promise<string | null> {
  const [row] = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.email, email))
    .limit(1);
  return row?.id ?? null;
}

/** The org's name and the inviter's email an invitation email names. */
export async function orgInvitationContext(orgId: string, inviterId: string) {
  const [org] = await db
    .select({ name: organizations.name })
    .from(organizations)
    .where(eq(organizations.id, orgId))
    .limit(1);
  const inviter = await readAuthUser(inviterId);
  return { orgName: org?.name ?? null, inviterEmail: inviter?.email ?? null };
}

/** The org's invitations nobody has accepted yet, each with its inviter's email. */
export async function listPendingOrgInvitations(orgId: string) {
  return db
    .select({
      email: orgInvitations.email,
      role: orgInvitations.role,
      expiresAt: orgInvitations.expiresAt,
      createdAt: orgInvitations.createdAt,
      inviterEmail: users.email,
    })
    .from(orgInvitations)
    .innerJoin(users, eq(users.id, orgInvitations.inviterId))
    .where(and(eq(orgInvitations.orgId, orgId), isNull(orgInvitations.acceptedAt)));
}

/** The invitation a token names, with its org's name and inviter's email, or null. */
export async function orgInvitationByToken(token: string) {
  const [row] = await db
    .select({
      email: orgInvitations.email,
      role: orgInvitations.role,
      expiresAt: orgInvitations.expiresAt,
      acceptedAt: orgInvitations.acceptedAt,
      orgName: organizations.name,
      inviterEmail: users.email,
    })
    .from(orgInvitations)
    .innerJoin(organizations, eq(organizations.id, orgInvitations.orgId))
    .innerJoin(users, eq(users.id, orgInvitations.inviterId))
    .where(eq(orgInvitations.token, token))
    .limit(1);
  return row ?? null;
}

/** The role `userId` holds in `orgId`, or null when they are not a member. */
export async function orgMemberRole(orgId: string, userId: string): Promise<OrgMemberRole | null> {
  const [row] = await db
    .select({ role: organizationMembers.role })
    .from(organizationMembers)
    .where(and(eq(organizationMembers.orgId, orgId), eq(organizationMembers.userId, userId)))
    .limit(1);
  return row?.role ?? null;
}

/** How many owners `orgId` has. */
export async function orgOwnerCount(orgId: string): Promise<number> {
  const [row] = await db
    .select({ n: count() })
    .from(organizationMembers)
    .where(and(eq(organizationMembers.orgId, orgId), eq(organizationMembers.role, 'owner')));
  return Number(row?.n ?? 0);
}
