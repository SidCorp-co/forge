import { and, asc, eq, inArray } from 'drizzle-orm';
import { db, type Tx } from '../db/client.js';
import { ecosystemMembershipEvents, ecosystemMemberships } from '../db/schema-ecosystem.js';
import type { MembershipRow, MembershipVerb } from './membership-rules.js';
import type { MembershipState } from './schema.js';

const membershipColumns = {
  id: ecosystemMemberships.id,
  ecosystemId: ecosystemMemberships.ecosystemId,
  projectId: ecosystemMemberships.projectId,
  state: ecosystemMemberships.state,
  invitedBy: ecosystemMemberships.invitedBy,
  invitedAt: ecosystemMemberships.invitedAt,
  decidedBy: ecosystemMemberships.decidedBy,
  decidedAt: ecosystemMemberships.decidedAt,
  endedAt: ecosystemMemberships.endedAt,
  endedReason: ecosystemMemberships.endedReason,
};

const asMembership = (row: { state: string } & Omit<MembershipRow, 'state'>): MembershipRow => ({
  ...row,
  state: row.state as MembershipState,
});

export async function readMembership(tx: Tx, id: string): Promise<MembershipRow | null> {
  const [row] = await tx
    .select(membershipColumns)
    .from(ecosystemMemberships)
    .where(eq(ecosystemMemberships.id, id))
    .limit(1);
  return row ? asMembership(row) : null;
}

export async function membershipsWhere(filter: {
  ecosystemIds?: readonly string[];
  projectIds?: readonly string[];
}): Promise<MembershipRow[]> {
  const conditions = [
    ...(filter.ecosystemIds
      ? [inArray(ecosystemMemberships.ecosystemId, [...filter.ecosystemIds])]
      : []),
    ...(filter.projectIds ? [inArray(ecosystemMemberships.projectId, [...filter.projectIds])] : []),
  ];
  if (filter.ecosystemIds?.length === 0 || filter.projectIds?.length === 0) return [];
  if (conditions.length === 0) throw new Error('ecosystem: membershipsWhere needs a filter');
  const rows = await db
    .select(membershipColumns)
    .from(ecosystemMemberships)
    .where(and(...conditions))
    .orderBy(ecosystemMemberships.invitedAt);
  return rows.map(asMembership);
}

export async function openMembership(
  tx: Tx,
  ecosystemId: string,
  projectId: string,
): Promise<MembershipRow | null> {
  const [row] = await tx
    .select(membershipColumns)
    .from(ecosystemMemberships)
    .where(
      and(
        eq(ecosystemMemberships.ecosystemId, ecosystemId),
        eq(ecosystemMemberships.projectId, projectId),
        inArray(ecosystemMemberships.state, ['invited', 'active']),
      ),
    )
    .limit(1);
  return row ? asMembership(row) : null;
}

export async function insertInvitation(
  tx: Tx,
  input: { ecosystemId: string; projectId: string; userId: string },
): Promise<MembershipRow> {
  const [row] = await tx
    .insert(ecosystemMemberships)
    .values({
      ecosystemId: input.ecosystemId,
      projectId: input.projectId,
      state: 'invited',
      invitedBy: input.userId,
    })
    .returning(membershipColumns);
  if (!row) throw new Error('ecosystem: the invitation insert returned no row');
  await tx.insert(ecosystemMembershipEvents).values({
    membershipId: row.id,
    verb: 'invite',
    fromState: null,
    toState: 'invited',
    actorId: input.userId,
  });
  return asMembership(row);
}

export async function applyTransition(
  tx: Tx,
  input: {
    row: MembershipRow;
    verb: MembershipVerb;
    to: MembershipState;
    userId: string;
    reason: string | null;
  },
): Promise<MembershipRow | null> {
  const { row, verb, to, userId, reason } = input;
  const now = new Date();
  const deciding = row.state === 'invited';
  const [updated] = await tx
    .update(ecosystemMemberships)
    .set({
      state: to,
      ...(deciding ? { decidedBy: userId, decidedAt: now } : { endedAt: now, endedReason: reason }),
    })
    .where(and(eq(ecosystemMemberships.id, row.id), eq(ecosystemMemberships.state, row.state)))
    .returning(membershipColumns);
  if (!updated) return null;
  await tx.insert(ecosystemMembershipEvents).values({
    membershipId: row.id,
    verb,
    fromState: row.state,
    toState: to,
    actorId: userId,
    reason,
    at: now,
  });
  return asMembership(updated);
}

export async function activeEcosystemIdsOf(
  tx: Tx,
  projectIds: readonly string[],
): Promise<{ projectId: string; ecosystemId: string }[]> {
  if (projectIds.length === 0) return [];
  return tx
    .select({
      projectId: ecosystemMemberships.projectId,
      ecosystemId: ecosystemMemberships.ecosystemId,
    })
    .from(ecosystemMemberships)
    .where(
      and(
        inArray(ecosystemMemberships.projectId, [...projectIds]),
        eq(ecosystemMemberships.state, 'active'),
      ),
    );
}

export async function isActiveMember(
  tx: Tx,
  projectId: string,
  ecosystemId: string,
): Promise<boolean> {
  return (await activeEcosystemIdsOf(tx, [projectId])).some((m) => m.ecosystemId === ecosystemId);
}

export async function activeMembersOf(tx: Tx, ecosystemId: string): Promise<string[]> {
  const rows = await tx
    .select({ projectId: ecosystemMemberships.projectId })
    .from(ecosystemMemberships)
    .where(
      and(
        eq(ecosystemMemberships.ecosystemId, ecosystemId),
        eq(ecosystemMemberships.state, 'active'),
      ),
    );
  return rows.map((r) => r.projectId);
}

/** Every act on one membership, oldest first: who invited, decided, left or removed it, and why. */
export async function membershipHistory(membershipId: string) {
  const rows = await db
    .select({
      verb: ecosystemMembershipEvents.verb,
      from: ecosystemMembershipEvents.fromState,
      to: ecosystemMembershipEvents.toState,
      actorId: ecosystemMembershipEvents.actorId,
      reason: ecosystemMembershipEvents.reason,
      at: ecosystemMembershipEvents.at,
    })
    .from(ecosystemMembershipEvents)
    .where(eq(ecosystemMembershipEvents.membershipId, membershipId))
    .orderBy(asc(ecosystemMembershipEvents.at), asc(ecosystemMembershipEvents.id));
  return rows.map((r) => ({ ...r, at: r.at.toISOString() }));
}
