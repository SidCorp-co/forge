// What takes an issue off `releasing` when no outcome was ever written.
//
// `finish` and `abort` are the two writers that leave `releasing` deliberately.
// Every other way a batch run can end — a failed release job, an operator
// cancelling the run, `reapOrphanedOneShotRuns`, a claim that lost its job to
// `ActiveJobConflictError` — clears `issues.release_batch_run_id` and says
// nothing about the status, which was harmless while the issue stood at the
// `released` gate and strands it the moment the middle status exists.
//
// So this is the third writer, and it is the only one a machine may use: an
// issue whose batch is gone without an outcome lands at `reopen` with the
// reason on it, exactly where `abort` puts one, because a half-landed release
// is a person's decision and not a retry.

import { eq, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { comments, issues, projects } from '../db/schema.js';
import type { TransitionActor } from '../issues/actor-agency.js';
import { TransitionError, transitionIssueStatus } from '../issues/apply-transition.js';
import { logger } from '../logger.js';

export interface RecoverStrandedReleasingResult {
  /** Issues whose claim was cleared, whatever their status. */
  released: string[];
  /** Issues that were still at `releasing` and were moved to `reopen`. */
  recovered: string[];
}

export interface RecoverStrandedReleasingOptions {
  /** Written onto the issue as the reason, and into a comment when an author is known. */
  reason: string;
  /** The person who caused this, when there is one. Absent for a machine sweep. */
  actorUserId?: string | undefined;
  /** Post a comment naming the reason. Off for a sweep nobody asked for. */
  comment?: boolean;
}

/**
 * Release every claim on `runId` and rescue whatever it left mid-release.
 *
 * Ordered recover-then-clear: the claim column is the only index onto the
 * batch's issues, so clearing first leaves nothing to read them back by.
 */
// cm:guard the ONE writer of this recovery, and both halves are the contract: it reads each issue's ACTUAL status and moves only the ones at `releasing`, because an issue at any other status was not put there by this batch and a hardcoded `from` would record a hop that never happened. Callers must not clear `release_batch_run_id` themselves — that column is how these rows are found, and a caller that clears it first hands this pass an empty set (measured as the shape that stranded rows at `releasing` with no run to read).
export async function recoverStrandedReleasing(
  runId: string,
  options: RecoverStrandedReleasingOptions,
): Promise<RecoverStrandedReleasingResult> {
  const claimed = await db
    .select({
      id: issues.id,
      projectId: issues.projectId,
      status: issues.status,
      reopenCount: issues.reopenCount,
      projectCreatedBy: projects.createdBy,
    })
    .from(issues)
    .innerJoin(projects, eq(projects.id, issues.projectId))
    .where(eq(issues.releaseBatchRunId, runId));

  const recovered: string[] = [];

  for (const issue of claimed) {
    if (issue.status !== 'releasing') continue;

    if (options.comment && options.actorUserId) {
      try {
        await db.insert(comments).values({
          issueId: issue.id,
          authorId: options.actorUserId,
          body: `${options.reason}. The issue is at \`reopen\` — a person decides whether it goes back to work or into another batch.`,
        });
      } catch (err) {
        logger.warn({ err, issueId: issue.id, runId }, 'release-batch: recovery comment failed');
      }
    }

    // cm:guard a synthesized DEVICE actor and not the project owner as a user: this hop is a machine noticing a dead batch, and recording it as the owner would put a transition they never made into the interventions-per-issue metric that counts user-actor writes. Same fallback shape as `parkIssueOnCancel` (pipeline/runs-control.ts) and for the same reason.
    const fallbackId = issue.projectCreatedBy ?? issue.projectId;
    const actor: TransitionActor = options.actorUserId
      ? { type: 'user', id: options.actorUserId }
      : { type: 'device', id: fallbackId, ownerId: fallbackId };

    try {
      await transitionIssueStatus(
        {
          id: issue.id,
          projectId: issue.projectId,
          status: issue.status,
          reopenCount: issue.reopenCount,
        },
        'reopen',
        actor,
        { transitionReason: options.reason, viaReleasePath: true },
      );
      recovered.push(issue.id);
    } catch (err) {
      if (!(err instanceof TransitionError && err.code === 'NO_OP')) {
        logger.warn(
          { err, issueId: issue.id, runId },
          'release-batch: could not recover a stranded releasing issue',
        );
      }
    }
  }

  await db.execute(sql`
    UPDATE issues SET release_batch_run_id = NULL, updated_at = now()
    WHERE release_batch_run_id = ${runId}
  `);

  if (recovered.length > 0) {
    logger.warn(
      { runId, recovered: recovered.length, reason: options.reason },
      'release-batch: issues rescued from `releasing` by a batch that wrote no outcome',
    );
  }

  return { released: claimed.map((r) => r.id), recovered };
}
