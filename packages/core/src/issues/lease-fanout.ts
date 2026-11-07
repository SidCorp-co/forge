import { ISSUE_TERMINAL_STATUSES } from '@forge/contracts/issue-machine';
import { sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import {
  classifyLease,
  type LeaseReading,
  leaseClaimantOf,
  leaseHolderOf,
  leaseIsUnexpired,
} from './session-claim.js';

/**
 * How many open issues each claimant — a holder, and the session its lease names
 * (`session-claim.ts:leaseClaimantOf`) — holds an unexpired claim on: `classifyLease`'s `shared`
 * test. Counted here, not in SQL: a cast would throw on the first unreadable lease a caller must name.
 */
export async function holderFanout(
  leases: readonly unknown[],
  now: Date,
): Promise<ReadonlyMap<string, number>> {
  const holders = [...new Set(leases.map(leaseHolderOf).filter((h): h is string => h !== null))];
  const counts = new Map<string, number>();
  if (holders.length === 0) return counts;

  const rows = (await db.execute(sql`
    SELECT (SELECT w.lease FROM issue_work_state w WHERE w.issue_id = i.id) AS lease
      FROM issues i
     WHERE i.status NOT IN (${sql.join(
       ISSUE_TERMINAL_STATUSES.map((s) => sql`${s}`),
       sql`, `,
     )})
       AND (SELECT w.lease ->> 'holder' FROM issue_work_state w WHERE w.issue_id = i.id) IN (${sql.join(
         holders.map((h) => sql`${h}`),
         sql`, `,
       )})
  `)) as unknown as Array<{ lease: unknown }>;
  for (const row of rows) {
    const claimant = leaseClaimantOf(row.lease);
    if (claimant === null || !leaseIsUnexpired(row.lease, now)) continue;
    counts.set(claimant, (counts.get(claimant) ?? 0) + 1);
  }
  return counts;
}

/** One row's claim, read against the fanout {@link holderFanout} counted for the same page. */
export function readClaim(
  lease: unknown,
  now: Date,
  fanout: ReadonlyMap<string, number>,
): LeaseReading {
  const claimant = leaseClaimantOf(lease);
  return classifyLease({
    lease,
    now,
    fanout: claimant === null ? 0 : (fanout.get(claimant) ?? 1),
  });
}
