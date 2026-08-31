import { and, eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { organizationMembers, organizations, users } from '../db/schema.js';

/**
 * Tx-compatible handle — both `db` and the `tx` inside `db.transaction`
 * satisfy this for the two inserts we need.
 */
type DbLike = Pick<typeof db, 'insert' | 'select'>;

/**
 * Idempotently provision the user's personal org (one per user, enforced by
 * the `organizations_personal_owner_uq` partial unique). Called at signup
 * (local register + OAuth first-login); existing users are covered by
 * migration 0106. Slug mirrors the migration: `personal-<userId>`.
 */
export async function ensurePersonalOrg(
  dbh: DbLike,
  userId: string,
  email: string,
): Promise<string> {
  const existing = await dbh
    .select({ id: organizations.id })
    .from(organizations)
    .where(and(eq(organizations.createdBy, userId), eq(organizations.isPersonal, true)))
    .limit(1);
  const found = existing.find(() => true);
  if (found) return found.id;

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
    // Lost a race — the partial unique swallowed our insert; re-read.
    const [row] = await dbh
      .select({ id: organizations.id })
      .from(organizations)
      .where(and(eq(organizations.createdBy, userId), eq(organizations.isPersonal, true)))
      .limit(1);
    if (!row) throw new Error('ensurePersonalOrg: insert and re-read both failed');
    return row.id;
  }

  await dbh
    .insert(organizationMembers)
    .values({ orgId: org.id, userId, role: 'owner' })
    .onConflictDoNothing();
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
  role: string;
  lenses: unknown;
  createdAt: Date;
};

/** The members of `orgId`. Authorization stays at the transport edge. */
// cm:guard `lenses` belongs to BOTH callers. The MCP copy of this query omitted it while REST returned it, so an agent listing members saw a different record than the UI did — the drift ISS-889 exists to remove, and re-narrowing the columns per transport brings it straight back.
export async function listOrgMembers(orgId: string): Promise<OrgMember[]> {
  return db
    .select({
      userId: organizationMembers.userId,
      email: users.email,
      role: organizationMembers.role,
      lenses: organizationMembers.lenses,
      createdAt: organizationMembers.createdAt,
    })
    .from(organizationMembers)
    .innerJoin(users, eq(users.id, organizationMembers.userId))
    .where(eq(organizationMembers.orgId, orgId));
}
