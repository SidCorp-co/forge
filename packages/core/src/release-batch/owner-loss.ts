// A release nobody owns any more, found and said out loud.
//
// Two ways a release loses its owner: no master took it before its deadline, or the run session
// that took it ended before a finish was accepted. Either way the pass declares the loss in one
// guarded write, and only the pass whose write landed acts on it. The guard is the same row the
// finish acceptance writes, so a finish accepted a moment earlier makes this write miss, and a loss
// declared a moment earlier makes the acceptance miss (`OWNER_NOT_LOST`).
//
// A run that already recorded a promotion may have put code on production, so its roster is never
// walked back from here: it is held at `releasing` for a person, and the wedge says so.

import { sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { terminalAgentSessionStatuses } from '../db/schema.js';
import { logger } from '../logger.js';
import { closeRunIfOneShot } from '../pipeline/runs.js';
import { emitPipelineWedge } from '../pipeline/wedge.js';
import {
  metadataWithOwner,
  NO_FINISH_IN_HAND,
  noFinishInHand,
  RELEASE_OWNER_KEY,
  type ReleaseOwner,
  readOwner,
} from './owner-record.js';
import { recoverStrandedReleasing, runRecordedPromotion } from './releasing-recovery.js';

export type OwnerLoss = 'untaken' | 'owner-ended';

const WHY: Record<OwnerLoss, string> = {
  untaken: 'no master took this release before its deadline, so it never started',
  'owner-ended': 'the run session that owned this release ended before a finish was accepted',
};

export interface OwnerLossResult {
  /** Cancelled with their rosters handed back to the release gate. */
  lost: string[];
  /** Held at `releasing` because the run recorded a promotion. */
  orphaned: string[];
}

interface LossRow extends Record<string, unknown> {
  id: string;
  project_id: string;
  metadata: unknown;
  owner_ended: boolean;
}

const terminalList = sql.join(
  terminalAgentSessionStatuses.map((s) => sql`${s}`),
  sql`, `,
);

/** Every open release whose owner is gone, and which holds no finish attempt. */
async function ownerless(now: Date): Promise<LossRow[]> {
  return (await db.execute<LossRow>(sql`
    SELECT r.id, r.project_id, r.metadata,
           (r.metadata -> ${RELEASE_OWNER_KEY} ->> 'state') = 'owned' AS owner_ended
      FROM pipeline_runs r
      LEFT JOIN agent_sessions s
        ON s.id::text = r.metadata -> ${RELEASE_OWNER_KEY} ->> 'sessionId'
     WHERE r.kind = 'system'
       AND r.status IN ('running', 'paused')
       AND r.metadata ->> 'source' = 'release-batch'
       AND ${noFinishInHand(sql`r.metadata`)}
       AND (
         ((r.metadata -> ${RELEASE_OWNER_KEY} ->> 'state') = 'awaiting'
           AND (r.metadata -> ${RELEASE_OWNER_KEY} ->> 'deadlineAt')::timestamptz < ${now.toISOString()}::timestamptz)
         OR ((r.metadata -> ${RELEASE_OWNER_KEY} ->> 'state') = 'owned'
           AND (s.id IS NULL OR s.status IN (${terminalList})))
       )
  `)) as unknown as LossRow[];
}

/**
 * Declare the loss, conditioned on everything that made it one: the owner state it was read at,
 * no finish in hand, the run still open. `false` where another writer got there first.
 */
async function declare(runId: string, from: ReleaseOwner, next: ReleaseOwner): Promise<boolean> {
  const rows = (await db.execute(sql`
    UPDATE pipeline_runs
       SET metadata = ${metadataWithOwner(next)}, updated_at = now()
     WHERE id = ${runId}
       AND status IN ('running', 'paused')
       AND (metadata -> ${RELEASE_OWNER_KEY} ->> 'state') = ${from.state}
       AND ${NO_FINISH_IN_HAND}
     RETURNING id
  `)) as unknown as Array<{ id: string }>;
  return rows.length > 0;
}

export async function recoverReleaseOwners(now: Date = new Date()): Promise<OwnerLossResult> {
  const result: OwnerLossResult = { lost: [], orphaned: [] };
  for (const row of await ownerless(now)) {
    try {
      const owner = readOwner(row.metadata, row.id);
      if (!owner) continue;
      const loss: OwnerLoss = row.owner_ended ? 'owner-ended' : 'untaken';
      const promoted = await runRecordedPromotion(row.id);
      const next: ReleaseOwner = {
        ...owner,
        state: promoted ? 'orphaned' : 'lost',
        endedAt: now.toISOString(),
        why: WHY[loss],
      };
      if (!(await declare(row.id, owner, next))) continue;
      if (promoted) {
        await emitOrphaned(row);
        result.orphaned.push(row.id);
        continue;
      }
      await recoverStrandedReleasing(row.id, { reason: WHY[loss] });
      await closeRunIfOneShot(row.id, 'cancelled');
      await emitLost(row, loss);
      result.lost.push(row.id);
    } catch (err) {
      logger.error({ err, runId: row.id }, 'release-batch: owner recovery failed for one release');
    }
  }
  if (result.lost.length + result.orphaned.length > 0) {
    logger.warn(result, 'release-batch: releases whose owner was gone');
  }
  return result;
}

async function emitLost(row: LossRow, loss: OwnerLoss): Promise<void> {
  const untaken = loss === 'untaken';
  await emitPipelineWedge({
    projectId: row.project_id,
    hop: untaken ? 'claim' : 'heartbeat',
    entity: 'run',
    entityId: row.id,
    reason: WHY[loss],
    action: untaken
      ? "Check that this project's master is running on a box that ships the release role and is not draining, then cut the release again."
      : 'Read the run that owned the release to see where it stopped, then cut the release again.',
    title: untaken
      ? 'A release was cancelled because no master took it'
      : 'A release was cancelled because the run that owned it ended',
    summary: untaken
      ? "The release was handed to this project's master, and no master took it before its deadline. Every issue in it is back at the release gate, so nothing is lost and nothing is half-released."
      : 'The run that owned the release ended before it said the release was done. Nothing had gone to production yet, so every issue in it is back at the release gate.',
    nextStep: untaken
      ? "Make sure this project's master is running on the machine that does its releases, then start the release again."
      : 'Look at what the release run last said, then start the release again.',
  });
}

async function emitOrphaned(row: LossRow): Promise<void> {
  await emitPipelineWedge({
    projectId: row.project_id,
    hop: 'heartbeat',
    entity: 'run',
    entityId: row.id,
    reason: `${WHY['owner-ended']}, after the release recorded a promotion`,
    action:
      'Read the release run; finish it if production is serving what it promoted, or abort it with promotedRoster "return-to-gate".',
    title: 'A release that had already promoted lost the run that owned it',
    summary:
      'The release had started putting code on production when the run that owned it ended, so its issues stay at releasing: no other status would be safe to claim.',
    nextStep:
      'Open the release, check what production is serving, and finish or abort it. Nothing will do that on its own.',
  });
}
