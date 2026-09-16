// The names a conversation surface prints, attached where names belong.
//
// `users.display_name` is a LABEL and decides nothing — it is free text its
// owner may change, and the address a mention resolves against is the handle
// instead. `db/display-name-readers.test.ts` holds that line by naming the
// modules that may read the column at all, and `conversations/` is named there
// one by one as a place that may not. So the store answers with ids and
// addresses, and this attaches what to call them on the way out (ISS-1003).

import { inArray } from 'drizzle-orm';
import { db as defaultDb } from '../db/client.js';
import { users } from '../db/schema.js';

/** Whatever the store hands back, as far as this module needs to know. */
export interface Nameable {
  kind: 'person' | 'handle';
  userId: string | null;
  label: string | null;
}

/**
 * The label to print for each member of a room.
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
      .select({ id: users.id, displayName: users.displayName, email: users.email })
      .from(users)
      .where(inArray(users.id, ids));
    for (const row of found) named.set(row.id, row.displayName ?? row.email);
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
      .select({ id: users.id, displayName: users.displayName, email: users.email })
      .from(users)
      .where(inArray(users.id, ids));
    for (const row of found) {
      const label = row.displayName ?? row.email;
      if (label) named.set(row.id, label);
    }
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
): Promise<Array<T & { displayName: string | null }>> {
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
    .map((c) => ({ ...c, displayName: named.get(c.userId) ?? null }))
    .sort((a, b) => (a.displayName ?? a.email).localeCompare(b.displayName ?? b.email));
}
