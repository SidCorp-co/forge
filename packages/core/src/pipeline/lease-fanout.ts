import { sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import {
  classifyLease,
  type LeaseReading,
  leaseHolderOf,
  leaseIsUnexpired,
} from './session-claim.js';

/**
 * How many open issues each holder holds an unexpired claim on — `classifyLease`'s `shared` test.
 * Counted here, not in SQL: a cast would throw on the first unreadable lease a caller must name.
 */
export async function holderFanout(
  leases: readonly unknown[],
  now: Date,
): Promise<ReadonlyMap<string, number>> {
  const holders = [...new Set(leases.map(leaseHolderOf).filter((h): h is string => h !== null))];
  const counts = new Map<string, number>();
  if (holders.length === 0) return counts;

  const rows = (await db.execute(sql`
    SELECT i.session_context -> 'lease' AS lease
      FROM issues i
     WHERE i.status NOT IN ('closed', 'dropped')
       AND i.session_context -> 'lease' ->> 'holder' IN (${sql.join(
         holders.map((h) => sql`${h}`),
         sql`, `,
       )})
  `)) as unknown as Array<{ lease: unknown }>;
  for (const row of rows) {
    const holder = leaseHolderOf(row.lease);
    if (holder === null || !leaseIsUnexpired(row.lease, now)) continue;
    counts.set(holder, (counts.get(holder) ?? 0) + 1);
  }
  return counts;
}

/** One row's claim, read against the fanout {@link holderFanout} counted for the same page. */
export function readClaim(
  lease: unknown,
  now: Date,
  fanout: ReadonlyMap<string, number>,
): LeaseReading {
  const holder = leaseHolderOf(lease);
  return classifyLease({ lease, now, fanout: holder === null ? 0 : (fanout.get(holder) ?? 1) });
}
