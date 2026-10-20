import { and, eq, inArray, ne, notExists } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { HTTPException } from 'hono/http-exception';
import { agentIsNotAPerson, isAgentAddress, isForgeAddress } from '../auth/agent-account.js';
import { FORGE_AUTHOR_ID } from '../comments/forge-author.js';
import { db } from '../db/client.js';
import { devices, organizationMembers, organizations, users } from '../db/schema.js';
import { givenName } from '../lib/person-name.js';

/**
 * Tx-compatible handle — both `db` and the `tx` inside `db.transaction`
 * satisfy this for the two inserts we need.
 */
type DbLike = Pick<typeof db, 'insert' | 'select'>;

export const PERSONAL_WORKSPACE_NAME = 'Personal';

/**
 * Delete an organization and the agent accounts that belonged to it and to no other, in one
 * transaction (ISS-1229 r22): nothing else names such an agent once the organization's projects are
 * gone, and left behind it is an account with no membership and no door to remove it. A revoked
 * device of such an agent goes with it; one not yet revoked refuses the delete by name.
 */
export async function deleteOrganization(orgId: string): Promise<void> {
  await db.transaction(async (tx) => {
    const elsewhere = alias(organizationMembers, 'elsewhere');
    const own = await tx
      .select({ id: users.id, handle: organizationMembers.handle })
      .from(organizationMembers)
      .innerJoin(users, eq(users.id, organizationMembers.userId))
      .where(
        and(
          eq(organizationMembers.orgId, orgId),
          eq(users.kind, 'agent'),
          notExists(
            tx
              .select({ userId: elsewhere.userId })
              .from(elsewhere)
              .where(and(eq(elsewhere.userId, users.id), ne(elsewhere.orgId, orgId))),
          ),
        ),
      )
      .for('update', { of: users });
    const ids = own.map((a) => a.id);
    if (ids.length > 0) {
      const [held] = await tx
        .select({ device: devices.name, ownerId: devices.ownerId })
        .from(devices)
        .where(and(inArray(devices.ownerId, ids), ne(devices.status, 'revoked')))
        .limit(1);
      if (held) {
        const agent = own.find((a) => a.id === held.ownerId);
        throw new HTTPException(409, {
          message: `This organization's agent @${agent?.handle ?? held.ownerId} still holds the device "${held.device}", so the organization was not deleted. Revoke that device under Runners, then delete the organization.`,
          cause: { code: 'ORG_AGENT_HOLDS_A_DEVICE' },
        });
      }
    }
    await tx.delete(organizations).where(eq(organizations.id, orgId));
    if (ids.length > 0) {
      await tx.delete(devices).where(inArray(devices.ownerId, ids));
      await tx.delete(users).where(inArray(users.id, ids));
    }
  });
}

/**
 * A personal workspace is named by its owner's display name, else "Personal", never their address
 * (ISS-1229); it follows while it carries one of those two, and any other name is the owner's own.
 */
export async function followDisplayName(
  dbh: Pick<typeof db, 'update'>,
  userId: string,
  before: string | null,
  after: string | null,
): Promise<void> {
  const prior = givenName(before);
  const automatic = prior ? [PERSONAL_WORKSPACE_NAME, prior] : [PERSONAL_WORKSPACE_NAME];
  await dbh
    .update(organizations)
    .set({ name: givenName(after) ?? PERSONAL_WORKSPACE_NAME })
    .where(
      and(
        eq(organizations.createdBy, userId),
        eq(organizations.isPersonal, true),
        inArray(organizations.name, automatic),
      ),
    );
}

/** Forge's own account writes what its sweeps say and is a member of nothing. */
export function isNeverAMember(userId: string): boolean {
  return userId === FORGE_AUTHOR_ID;
}

/** The one refusal every door that adds a member or invites one answers Forge with, by id or by
 *  address in any letter case, whether or not its account has been minted yet. */
export function forgeIsNotAMember(named: string): HTTPException {
  return new HTTPException(409, {
    message: `Forge's own account (${named}) is never a member of an organization or a project. It only writes what Forge's sweeps say.`,
    cause: { code: 'FORGE_IS_NOT_A_MEMBER' },
  });
}

/** Refuse an invitation or a membership naming Forge, by address or by account id. */
export function refuseForgeAsMember(target: { email?: string; userId?: string }): void {
  if (target.email !== undefined && isForgeAddress(target.email)) {
    throw forgeIsNotAMember(target.email);
  }
  if (target.userId !== undefined && isNeverAMember(target.userId)) {
    throw forgeIsNotAMember(`account ${target.userId}`);
  }
}

/** Refuse an invitation or a membership naming anything but a person: Forge by its own code first,
 *  then any address on the agent domain, in any letter case, and any agent account by id. */
export async function refuseNonPersonAsMember(target: {
  email?: string;
  userId?: string;
}): Promise<void> {
  refuseForgeAsMember(target);
  if (target.email !== undefined && isAgentAddress(target.email)) {
    throw agentIsNotAPerson({ email: target.email });
  }
  if (target.userId === undefined) return;
  const [row] = await db
    .select({ kind: users.kind, email: users.email })
    .from(users)
    .where(eq(users.id, target.userId))
    .limit(1);
  if (row && (row.kind === 'agent' || isAgentAddress(row.email))) {
    throw agentIsNotAPerson({ userId: target.userId });
  }
}

/**
 * Idempotently provision the user's personal org (one per user, enforced by
 * the `organizations_personal_owner_uq` partial unique). Called at signup
 * (local register + OAuth first-login); existing users are covered by
 * migration 0106. Slug mirrors the migration: `personal-<userId>`.
 */
export async function ensurePersonalOrg(dbh: DbLike, userId: string): Promise<string> {
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
      name: PERSONAL_WORKSPACE_NAME,
      isPersonal: true,
      createdBy: userId,
    })
    .onConflictDoNothing()
    .returning({ id: organizations.id });
  const org = inserted[0];
  if (!org) {
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
  /** The label a person reads, or null where nobody has typed one. */
  displayName: string | null;
  /** The address this member is reached at in this org, or null for a person. */
  handle: string | null;
  role: string;
  lenses: string[];
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
