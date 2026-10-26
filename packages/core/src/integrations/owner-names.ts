import { listedAs } from '@forge/contracts/people-apart';
import { and, asc, eq, inArray } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { db } from '../db/client.js';
import { organizationMembers, organizations } from '../db/schema.js';
import { userLabels } from '../issues/actor-resolution.js';
import { listOrgMembers } from '../orgs/service.js';
import type { IntegrationConnectionRow } from './store.js';

type Owned = Pick<IntegrationConnectionRow, 'id' | 'ownerType' | 'ownerId'>;

/**
 * Each connection's owner as a sentence names them: an organization by name, a person as
 * `personName` calls them mid-sentence ("another member"), never by address (ISS-1216, ISS-1229).
 * Keyed by connection id; an owner that no longer resolves is absent.
 */
export async function ownerNamesOf(connections: Owned[]): Promise<Map<string, string>> {
  const orgIds = new Set<string>();
  const userIds = new Set<string>();
  for (const c of connections) (c.ownerType === 'org' ? orgIds : userIds).add(c.ownerId);

  const orgNames = new Map<string, string>();
  if (orgIds.size > 0) {
    const rows = await db
      .select({ id: organizations.id, name: organizations.name })
      .from(organizations)
      .where(inArray(organizations.id, [...orgIds]));
    for (const row of rows) orgNames.set(row.id, row.name);
  }
  const personLabels = await userLabels([...userIds], 'inside');

  const out = new Map<string, string>();
  for (const c of connections) {
    const name = (c.ownerType === 'org' ? orgNames : personLabels).get(c.ownerId);
    if (name) out.set(c.id, name);
  }
  return out;
}

/** Where a reader finds a person who set no name: an organization both belong to, and its row there. */
export interface ListedOwner {
  orgName: string;
  /** The person as that organization's Members list draws them to the reader ("Another member (added 3 Oct 2026)"). */
  listed: string;
}

/**
 * A nameless owner as the Members list of the first organization by name the reader shares with them
 * shows them; null where they share none (ISS-1421 r29).
 */
export async function namelessOwnerListing(
  ownerId: string,
  readerId: string,
): Promise<ListedOwner | null> {
  const readerSide = alias(organizationMembers, 'reader_side');
  const [shared] = await db
    .select({ orgId: organizations.id, orgName: organizations.name })
    .from(organizationMembers)
    .innerJoin(readerSide, eq(readerSide.orgId, organizationMembers.orgId))
    .innerJoin(organizations, eq(organizations.id, organizationMembers.orgId))
    .where(and(eq(organizationMembers.userId, ownerId), eq(readerSide.userId, readerId)))
    .orderBy(asc(organizations.name), asc(organizations.id))
    .limit(1);
  if (!shared) return null;
  const people = (await listOrgMembers(shared.orgId))
    .filter((m) => m.kind === 'person')
    .map((m) => ({
      userId: m.userId,
      displayName: m.displayName,
      addedAt: m.createdAt.toISOString(),
    }));
  const owner = people.find((p) => p.userId === ownerId);
  if (!owner) return null;
  return { orgName: shared.orgName, listed: listedAs(owner, people, readerId) };
}
