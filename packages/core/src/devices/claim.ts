/**
 * A master agent taking one job, and the kernel recording that it did.
 *
 * The routing decision is the master's and is not re-litigated here. What
 * this owns is the part that must hold when the master is gone: one holder
 * per job, and a device row locked while the count is taken.
 */

import { and, eq, isNull, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { jobs } from '../db/schema.js';
import { mintJobToken } from '../jobs/job-token.js';

export type ClaimResult =
  | { ok: true; jobId: string; jobToken: string; issueKey: string | null }
  | { ok: false; reason: 'not_found' | 'already_held' | 'device_busy' };

/**
 * Claim one queued job for `sessionId` on `deviceId`.
 *
 * Refuses on physical fullness — a truth about the box the master cannot see —
 * and on losing the race for a job another master took first.
 */
// cm:guard the hold and the count MUST happen under one locked device row, the same discipline `claimRunnerSlot` uses. Two masters on one box asking "is there room" outside a lock both read the same free slot and both take it; the lock is what makes the second one lose.
// cm:guard a refusal here is NOT a job failure and must never touch `attempts` or `failure_kind`. A full box is the ordinary case, and spending a retry on it burns an issue's budget on something that was never wrong.
export async function claimJobForMaster(args: {
  jobId: string;
  deviceId: string;
  sessionId: string;
}): Promise<ClaimResult> {
  // cm:guard the token is minted AFTER this transaction commits, never inside it. `mintJobToken` writes through the module-level `db` rather than the passed `tx`, so a mint placed inside would survive a rollback — a live credential for a job whose hold never landed, with nothing left pointing at it to revoke.
  const claimed = await db.transaction(async (tx) => {
    const deviceRows = (await tx.execute(sql`
      SELECT d.id FROM devices d WHERE d.id = ${args.deviceId} FOR UPDATE OF d
    `)) as unknown as Array<Record<string, unknown>>;
    if (!deviceRows[0]) return { kind: 'not_found' } as const;

    const held = await tx
      .update(jobs)
      .set({ heldBy: args.sessionId, heldAt: sql`now()` })
      .where(and(eq(jobs.id, args.jobId), eq(jobs.status, 'queued'), isNull(jobs.heldBy)))
      .returning({
        id: jobs.id,
        issueId: jobs.issueId,
        projectId: jobs.projectId,
        createdBy: jobs.createdBy,
      });

    const row = held[0];
    if (!row) return { kind: 'already_held' } as const;

    const keyRows = row.issueId
      ? ((await tx.execute(sql`
          SELECT i.iss_seq FROM issues i WHERE i.id = ${row.issueId} LIMIT 1
        `)) as unknown as Array<Record<string, unknown>>)
      : [];

    return {
      kind: 'held',
      row,
      issSeq: (keyRows[0]?.iss_seq as number | null) ?? null,
    } as const;
  });

  if (claimed.kind !== 'held') return { ok: false, reason: claimed.kind };

  const jobToken = await mintJobToken({
    id: claimed.row.id,
    projectId: claimed.row.projectId,
    createdBy: claimed.row.createdBy,
  });
  // cm:guard a mint that fails MUST give the hold back before returning. Leaving it set would park the job on a master that never received a credential for it, and only the 3-minute reaper would notice — a slot lost to a failure that was visible right here.
  if (!jobToken) {
    await releaseJobFromMaster({ jobId: claimed.row.id, sessionId: args.sessionId });
    return { ok: false, reason: 'not_found' };
  }

  return {
    ok: true,
    jobId: claimed.row.id,
    jobToken,
    issueKey: claimed.issSeq == null ? null : `ISS-${claimed.issSeq}`,
  };
}

/** Give a held job back to the pool. */
// cm:guard release must clear the hold WITHOUT touching `status` — the job goes back to being claimable, not back to being retried. A release that also reset status would make "I changed my mind about the order" indistinguishable from "this attempt failed".
export async function releaseJobFromMaster(args: {
  jobId: string;
  sessionId: string;
}): Promise<boolean> {
  const rows = await db
    .update(jobs)
    .set({ heldBy: null, heldAt: null })
    .where(and(eq(jobs.id, args.jobId), eq(jobs.heldBy, args.sessionId)))
    .returning({ id: jobs.id });
  return rows.length > 0;
}

/**
 * Release every job a dead master was holding.
 *
 * A job already running keeps its hold cleared but is left alone otherwise:
 * the process outlives the master that started it, and killing it would
 * throw away a diff no one asked to discard.
 */
// cm:guard THE load-bearing link of the whole design. Without it a master that dies at 3am leaves its jobs unclaimable forever, and nothing reports why — the exact silent wedge `VISION: state-never-lies` calls a kernel bug. It is called from the runner when the local socket drops and from the session reaper when the heartbeat stops; both paths must stay, because a box that loses power never drops a socket.
export async function releaseAllHeldBySession(sessionId: string): Promise<number> {
  const rows = await db
    .update(jobs)
    .set({ heldBy: null, heldAt: null })
    .where(eq(jobs.heldBy, sessionId))
    .returning({ id: jobs.id });
  return rows.length;
}
