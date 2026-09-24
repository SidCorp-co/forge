/**
 * ISS-1213 — whether anything is on an issue now, which the lane's `running` needs to be true. It is
 * the negation of the strand pass's idle test (`pipeline/idle-issues.ts:judge`), built from the same
 * two pieces — the work-in-flight predicate, or a claim `classifyLease` reads `live` — so the board
 * and the sweep never disagree about one row.
 */

import { sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { holderFanout } from '../pipeline/lease-fanout.js';
import { classifyLease, leaseHolderOf, leaseIsWorkInProgress } from '../pipeline/session-claim.js';
import { issueWorkInFlightSql } from './issue-lease.js';

interface HeldRow {
  id: string;
  lease: unknown;
  in_flight: boolean;
}

export async function hydrateHeldForIssues(
  issueIds: readonly string[],
  now: Date = new Date(),
): Promise<Map<string, boolean>> {
  const held = new Map<string, boolean>();
  if (issueIds.length === 0) return held;

  const inFlight = issueWorkInFlightSql({
    issueId: sql`i.id`,
    projectId: sql`i.project_id`,
    issueKey: sql`'ISS-' || i.iss_seq`, // ISS-992:canonical
  });
  const rows = (await db.execute(sql`
    SELECT i.id, i.session_context -> 'lease' AS lease, ${inFlight} AS in_flight
      FROM issues i
     WHERE i.id IN (${sql.join(
       issueIds.map((id) => sql`${id}::uuid`),
       sql`, `,
     )})
  `)) as unknown as HeldRow[];

  const fanout = await holderFanout(
    rows.map((r) => r.lease),
    now,
  );
  for (const row of rows) {
    const holder = leaseHolderOf(row.lease);
    const claim = classifyLease({
      lease: row.lease,
      now,
      fanout: holder === null ? 0 : (fanout.get(holder) ?? 1),
    });
    held.set(row.id, row.in_flight === true || leaseIsWorkInProgress(claim.verdict));
  }
  return held;
}
