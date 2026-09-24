/**
 * ISS-1213 — whether a box is on an issue now, which the lane's `running` needs to be true: a job
 * the pipeline is moving, a running run, a held issue lease, or a claim read `live`. Narrower than
 * the strand pass's idle test, which asks whether a row needs escalating, not whether it moves.
 */

import { sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { holderFanout, readClaim } from '../pipeline/lease-fanout.js';
import { leaseIsWorkInProgress } from '../pipeline/session-claim.js';
import { issueWorkMovingSql } from './issue-lease.js';

interface HeldRow {
  id: string;
  lease: unknown;
  moving: boolean;
}

/** Refuses by name an id no row answers for, rather than reading it as not held. */
export async function hydrateHeldForIssues(
  issueIds: readonly string[],
  now: Date = new Date(),
): Promise<Map<string, boolean>> {
  const held = new Map<string, boolean>();
  if (issueIds.length === 0) return held;

  const moving = issueWorkMovingSql({
    issueId: sql`i.id`,
    projectId: sql`i.project_id`,
    issueKey: sql`'ISS-' || i.iss_seq`, // ISS-992:canonical
  });
  const rows = (await db.execute(sql`
    SELECT i.id, i.session_context -> 'lease' AS lease, ${moving} AS moving
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
    const claim = readClaim(row.lease, now, fanout);
    held.set(row.id, row.moving === true || leaseIsWorkInProgress(claim.verdict));
  }
  const unanswered = issueIds.filter((id) => !held.has(id));
  if (unanswered.length > 0) {
    throw new Error(
      `held-hydrator: no issue row answered for ${unanswered.join(', ')}, so whether a box is on it is unknown`,
    );
  }
  return held;
}
