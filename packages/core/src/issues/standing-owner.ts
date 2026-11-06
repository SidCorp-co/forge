// Who an issue's standing names as its owner (ISS-1068): its assignee, else whoever filed it, except
// an account of the retired steward, which owns no work. An unassigned issue the steward filed names
// no owner, and its standing says what it waits on (the master takes a draft on or drops it).

import { inArray } from 'drizzle-orm';
import { db } from '../db/client.js';
import { stewardAccounts } from '../db/schema-steward-runs.js';

export function ownerIdOf(
  ids: { assignee: string | null; creator: string | null },
  stewards: ReadonlySet<string>,
): string | null {
  if (ids.assignee) return ids.assignee;
  return ids.creator && !stewards.has(ids.creator) ? ids.creator : null;
}

/** Which of `userIds` are a steward account. */
export async function stewardAccountsAmong(
  userIds: readonly (string | null)[],
): Promise<ReadonlySet<string>> {
  const ids = [...new Set(userIds.filter((id): id is string => id !== null))];
  if (ids.length === 0) return new Set();
  const rows = await db
    .select({ userId: stewardAccounts.userId })
    .from(stewardAccounts)
    .where(inArray(stewardAccounts.userId, ids));
  return new Set(rows.map((r) => r.userId));
}
