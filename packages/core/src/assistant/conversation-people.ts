import { inArray } from 'drizzle-orm';
import { db as defaultDb } from '../db/client.js';
import { users } from '../db/schema.js';
import { personName } from '../lib/person-name.js';

/** Whatever the store hands back, as far as this module needs to know. */
export interface Nameable {
  kind: 'person' | 'handle';
  userId: string | null;
  label: string | null;
}

/**
 * The label to print for each member of a room: what `personName` calls a person, never their address.
 */
export async function withDisplayNames<T extends Nameable>(
  rows: readonly T[],
  db: typeof defaultDb = defaultDb,
): Promise<Array<T & { displayName: string | null }>> {
  const ids = [
    ...new Set(rows.flatMap((r) => (r.kind === 'person' && r.userId ? [r.userId] : []))),
  ];
  const named = new Map<string, string | null>();
  if (ids.length > 0) {
    const found = await db
      .select({ id: users.id, displayName: users.displayName })
      .from(users)
      .where(inArray(users.id, ids));
    for (const row of found) named.set(row.id, personName(row.displayName, 'start'));
  }
  return rows.map((row) => ({
    ...row,
    displayName:
      row.kind === 'handle' ? row.label : (named.get(row.userId ?? '') ?? row.label ?? null),
  }));
}

/**
 * The same, for the people an agent would put OUT of the room.
 */
export async function nameLostReaders<T extends { losesReaderIds: string[] }>(
  candidates: readonly T[],
  db: typeof defaultDb = defaultDb,
): Promise<Array<Omit<T, 'losesReaderIds'> & { losesReaders: string[] }>> {
  const ids = [...new Set(candidates.flatMap((c) => c.losesReaderIds))];
  const named = new Map<string, string>();
  if (ids.length > 0) {
    const found = await db
      .select({ id: users.id, displayName: users.displayName })
      .from(users)
      .where(inArray(users.id, ids));
    for (const row of found) named.set(row.id, personName(row.displayName, 'start'));
  }
  return candidates.map(({ losesReaderIds, ...rest }) => ({
    ...rest,
    losesReaders: losesReaderIds.flatMap((id) => {
      const label = named.get(id);
      return label ? [label] : [];
    }),
  }));
}

/** The same, for the people a room could still take in. */
export async function namePeople<T extends { userId: string; email: string }>(
  candidates: readonly T[],
  db: typeof defaultDb = defaultDb,
): Promise<Array<T & { displayName: string }>> {
  const ids = candidates.map((c) => c.userId);
  const named = new Map<string, string | null>();
  if (ids.length > 0) {
    const found = await db
      .select({ id: users.id, displayName: users.displayName })
      .from(users)
      .where(inArray(users.id, ids));
    for (const row of found) named.set(row.id, row.displayName);
  }
  return candidates
    .map((c) => ({ ...c, displayName: personName(named.get(c.userId), 'start') }))
    .sort((a, b) => a.displayName.localeCompare(b.displayName));
}
