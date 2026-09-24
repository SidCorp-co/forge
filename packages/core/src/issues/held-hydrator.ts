/**
 * ISS-1213 — whether a box is on an issue now, which the lane's `running` needs to be true: a job
 * the pipeline is moving, a running run, a held issue lease, or a claim read `live`. Narrower than
 * the strand pass's idle test, which asks whether a row needs escalating, not whether it moves.
 *
 * Beside it, when anything last spoke for the row: what the board can say about a row nothing
 * holds, since core cannot know whether a run it was never told about is working it.
 */

import { sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { holderFanout, readClaim } from '../pipeline/lease-fanout.js';
import { leaseIsWorkInProgress } from '../pipeline/session-claim.js';
import { issueWorkMovingSql } from './issue-lease.js';

export interface IssueHold {
  held: boolean;
  /** ISO time of the latest check-in core has for the row, `null` where it has none. */
  lastCheckInAt: string | null;
}

interface HeldRow {
  id: string;
  lease: unknown;
  moving: boolean;
  session_beat: Date | string | null;
}

/** The claim's own times that parse; one that does not gives no time rather than a guess. */
function claimTimes(lease: unknown): number[] {
  if (typeof lease !== 'object' || lease === null || Array.isArray(lease)) return [];
  const obj = lease as Record<string, unknown>;
  const beat = obj.heartbeat;
  const beatAt =
    typeof beat === 'object' && beat !== null && !Array.isArray(beat)
      ? (beat as Record<string, unknown>).at
      : undefined;
  return [obj.renewedAt, obj.stopped, beatAt]
    .filter((v): v is string => typeof v === 'string')
    .map((v) => Date.parse(v))
    .filter((t) => Number.isFinite(t));
}

function latestCheckIn(lease: unknown, sessionBeat: Date | string | null): string | null {
  const times = claimTimes(lease);
  if (sessionBeat !== null) {
    const t = new Date(sessionBeat).getTime();
    if (Number.isFinite(t)) times.push(t);
  }
  return times.length === 0 ? null : new Date(Math.max(...times)).toISOString();
}

/** Refuses by name an id no row answers for, rather than reading it as not held. */
export async function hydrateHeldForIssues(
  issueIds: readonly string[],
  now: Date = new Date(),
): Promise<Map<string, IssueHold>> {
  const held = new Map<string, IssueHold>();
  if (issueIds.length === 0) return held;

  const moving = issueWorkMovingSql({
    issueId: sql`i.id`,
    projectId: sql`i.project_id`,
    issueKey: sql`'ISS-' || i.iss_seq`, // ISS-992:canonical
  });
  // A session behind the issue's lease, or under one of its runs, beat last at this time.
  const rows = (await db.execute(sql`
    SELECT i.id, i.session_context -> 'lease' AS lease, ${moving} AS moving,
           GREATEST(
             (SELECT MAX(ls.last_heartbeat_at)
                FROM issue_leases l
                JOIN agent_sessions ls ON ls.id = l.session_id
               WHERE l.project_id = i.project_id
                 AND l.issue_key = 'ISS-' || i.iss_seq), -- ISS-992:canonical
             (SELECT MAX(rs.last_heartbeat_at)
                FROM pipeline_runs r
                JOIN agent_sessions rs ON rs.pipeline_run_id = r.id
               WHERE r.issue_id = i.id)
           ) AS session_beat
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
    held.set(row.id, {
      held: row.moving === true || leaseIsWorkInProgress(claim.verdict),
      lastCheckInAt: latestCheckIn(row.lease, row.session_beat),
    });
  }
  const unanswered = issueIds.filter((id) => !held.has(id));
  if (unanswered.length > 0) {
    throw new Error(
      `held-hydrator: no issue row answered for ${unanswered.join(', ')}, so whether a box is on it is unknown`,
    );
  }
  return held;
}
