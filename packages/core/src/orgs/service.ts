import { and, eq, isNull, sql } from 'drizzle-orm';
import { db, type Tx } from '../db/client.js';
import {
  type OrgMemberRole,
  organizationMembers,
  organizations,
  orgInvitations,
  users,
} from '../db/schema.js';
import { addOrgMember, removeOrgMember, updateOrgMember } from '../permissions/index.js';

/** The user's personal org (created at signup, or by migration 0106 for older users). */
export async function findPersonalOrgId(
  userId: string | null | undefined,
  dbh: Tx = db,
): Promise<string | null> {
  if (!userId) return null;
  const [row] = await dbh
    .select({ id: organizations.id })
    .from(organizations)
    .where(and(eq(organizations.createdBy, userId), eq(organizations.isPersonal, true)))
    .limit(1);
  return row?.id ?? null;
}

export async function isPersonalOrg(orgId: string): Promise<boolean> {
  const [row] = await db
    .select({ isPersonal: organizations.isPersonal })
    .from(organizations)
    .where(eq(organizations.id, orgId))
    .limit(1);
  return row?.isPersonal ?? false;
}

/**
 * Idempotently provision the user's personal org (one per user, enforced by
 * the `organizations_personal_owner_uq` partial unique). Called at signup
 * (local register + OAuth first-login); existing users are covered by
 * migration 0106. Slug mirrors the migration: `personal-<userId>`.
 */
export async function ensurePersonalOrg(
  dbh: Tx,
  userId: string,
  email: string,
): Promise<string> {
  const found = await findPersonalOrgId(userId, dbh);
  if (found) return found;

  const inserted = await dbh
    .insert(organizations)
    .values({
      slug: `personal-${userId}`,
      name: email.split('@')[0] || 'personal',
      isPersonal: true,
      createdBy: userId,
    })
    .onConflictDoNothing()
    .returning({ id: organizations.id });
  const org = inserted[0];
  if (!org) {
    const raced = await findPersonalOrgId(userId, dbh);
    if (!raced) throw new Error('ensurePersonalOrg: insert and re-read both failed');
    return raced;
  }

  await addOrgMember(dbh, { orgId: org.id, userId, role: 'owner' }, { ifAbsent: true });
  return org.id;
}

/** One org the caller belongs to, with the caller's own role in it. */
export type OrgMembership = {
  id: string;
  slug: string;
  name: string;
  isPersonal: boolean;
  role: string;
  createdAt: Date;
};

/** Every org `userId` belongs to; the personal one included, flagged by `isPersonal`. */
export async function listOrgsForUser(userId: string): Promise<OrgMembership[]> {
  return db
    .select({
      id: organizations.id,
      slug: organizations.slug,
      name: organizations.name,
      isPersonal: organizations.isPersonal,
      role: organizationMembers.role,
      createdAt: organizations.createdAt,
    })
    .from(organizationMembers)
    .innerJoin(organizations, eq(organizations.id, organizationMembers.orgId))
    .where(eq(organizationMembers.userId, userId));
}

/** One member of an org, as both transports report them. */
export type OrgMember = {
  userId: string;
  email: string;
  /** The label a person reads, or null where nobody has typed one. */
  displayName: string | null;
  /** The address this member is reached at in this org, or null for a person. */
  handle: string | null;
  role: string;
  lenses: unknown;
  createdAt: Date;
};

/** The members of `orgId`. Authorization stays at the transport edge. */
export async function listOrgMembers(orgId: string): Promise<OrgMember[]> {
  return db
    .select({
      userId: organizationMembers.userId,
      email: users.email,
      displayName: users.displayName,
      handle: organizationMembers.handle,
      role: organizationMembers.role,
      lenses: organizationMembers.lenses,
      createdAt: organizationMembers.createdAt,
    })
    .from(organizationMembers)
    .innerJoin(users, eq(users.id, organizationMembers.userId))
    .where(eq(organizationMembers.orgId, orgId));
}

const orgHead = {
  id: organizations.id,
  slug: organizations.slug,
  name: organizations.name,
  isPersonal: organizations.isPersonal,
  createdAt: organizations.createdAt,
};

/** A team org `userId` creates and owns; a taken slug throws the unique violation. */
export async function createTeamOrg(userId: string, input: { slug: string; name: string }) {
  return db.transaction(async (tx) => {
    const [org] = await tx
      .insert(organizations)
      .values({ slug: input.slug, name: input.name, isPersonal: false, createdBy: userId })
      .returning(orgHead);
    if (!org) throw new Error('organizations: insert returned no row');
    await addOrgMember(tx, { orgId: org.id, userId, role: 'owner' });
    return org;
  });
}

/** The org takes the patch; null when it does not exist. */
export async function updateOrg(orgId: string, patch: { name?: string | undefined }) {
  const [updated] = await db
    .update(organizations)
    .set({ ...(patch.name !== undefined ? { name: patch.name } : {}) })
    .where(eq(organizations.id, orgId))
    .returning(orgHead);
  return updated ?? null;
}

/** Delete the org row. */
export async function deleteOrg(orgId: string): Promise<void> {
  await db.delete(organizations).where(eq(organizations.id, orgId));
}

/** Add an existing user to the org; null when they were already a member. */
export async function addExistingOrgMember(orgId: string, userId: string, role: OrgMemberRole) {
  return addOrgMember(db, { orgId, userId, role }, { ifAbsent: true });
}

/** Revoke the pending invitation for `email`; false when there was none. */
export async function revokeOrgInvitation(orgId: string, email: string): Promise<boolean> {
  const deleted = await db
    .delete(orgInvitations)
    .where(
      and(
        eq(orgInvitations.orgId, orgId),
        eq(orgInvitations.email, email),
        isNull(orgInvitations.acceptedAt),
      ),
    )
    .returning({ token: orgInvitations.token });
  return deleted.length > 0;
}

/** Change a member's role or lenses; null when the membership is gone. */
export async function changeOrgMember(
  orgId: string,
  userId: string,
  patch: { role?: OrgMemberRole | undefined; lenses?: readonly string[] | undefined },
) {
  return updateOrgMember(db, orgId, userId, patch);
}

/** Remove a member from the org. */
export async function dropOrgMember(orgId: string, userId: string): Promise<void> {
  await removeOrgMember(db, orgId, userId);
}

/** Dismiss the pending invitation `token` when it was sent to `email`; false when none matched. */
export async function declineOrgInvitation(token: string, email: string): Promise<boolean> {
  const [updated] = await db
    .update(orgInvitations)
    .set({ dismissedAt: new Date() })
    .where(
      and(
        eq(orgInvitations.token, token),
        sql`lower(${orgInvitations.email}) = lower(${email})`,
        isNull(orgInvitations.acceptedAt),
      ),
    )
    .returning({ token: orgInvitations.token });
  return updated !== undefined;
}
