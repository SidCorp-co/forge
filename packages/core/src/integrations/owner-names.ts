import { inArray } from 'drizzle-orm';
import { db } from '../db/client.js';
import { organizations } from '../db/schema.js';
import { userLabels } from '../issues/actor-resolution.js';
import type { IntegrationConnectionRow } from './store.js';

type Owned = Pick<IntegrationConnectionRow, 'id' | 'ownerType' | 'ownerId'>;

/**
 * Each connection's owner as the product names them: an organization by name, a person by display
 * name else email (ISS-1216). Keyed by connection id; an owner that no longer resolves is absent.
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
  const personLabels = await userLabels([...userIds]);

  const out = new Map<string, string>();
  for (const c of connections) {
    const name = (c.ownerType === 'org' ? orgNames : personLabels).get(c.ownerId);
    if (name) out.set(c.id, name);
  }
  return out;
}
