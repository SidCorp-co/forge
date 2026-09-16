// What takes an issue off `releasing` when no outcome was ever written.
//
// `finish` and `abort` are the two writers that leave `releasing` deliberately.
// Every other way a batch run can end — a failed release job, an operator
// cancelling the run, `reapOrphanedOneShotRuns`, a claim that lost its job to
// `ActiveJobConflictError` — clears `issues.release_batch_run_id` and says
// nothing about the status, which was harmless while the issue stood at the
// `awaiting_release` gate and strands it the moment the middle status exists.
//
// So this is the third writer, and it is the only one a machine may use.
//
// It had ONE destination, `reopen`, for every issue it touched, and that was
// wrong in both directions (ISS-1042). A batch that never promoted anything put
// its whole roster through a hop nothing happened at — the issues were still
// merged, still verified, still waiting for production, and `reopen` said they
// had come back from it. A batch that DID promote had its roster sent to
// `reopen` too, which reads as work to redo over code that is on production
// right now.
//
// So the destination is chosen by what the run RECORDED, from the ledger:
//   - no promotion, and the project has a release gate → back to that gate
//   - no promotion, and it has none → `reopen`, as before
//   - a promotion → nothing moves. The roster stays at `releasing` and keeps
//     its claim, because an issue at `releasing` with no claim is unreachable,
//     and a half-landed release is a person's decision rather than a status.

import { and, eq, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { comments, type IssueStatus, issues, projects } from '../db/schema.js';
import { releaseAttempts } from '../db/schema-release-ledger.js';
import type { TransitionActor } from '../issues/actor-agency.js';
import { TransitionError, transitionIssueStatus } from '../issues/apply-transition.js';
import { logger } from '../logger.js';
import { resolveReleaseGate } from './gate.js';

export interface RecoverStrandedReleasingResult {
  /** Issues whose claim was cleared, whatever their status. */
  claimsCleared: string[];
  /** Issues that were still at `releasing` and were moved off it. */
  recovered: string[];
  /** Where the recovered issues went, or `null` when nothing moved. */
  destination: IssueStatus | null;
  /** True when the run recorded a promotion, so nothing was moved at all. */
  promoted: boolean;
}

/**
 * Did this run put anything on production?
 *
 * A `promote` attempt EXISTS is the question, not whether it succeeded: an act
 * that was declared and never reported back is exactly the one that may have
 * landed, and reading an unsettled promotion as "nothing happened" is how a
 * roster gets walked back over code that is serving.
 */
// cm:edge lockstep -> packages/core/src/release-batch/ledger.ts — `openAttempt` writes the intent BEFORE the act, and this read depends on that order. Move the write after the act and this answers "no promotion" for every release killed mid-promote, which is the case it exists for.
export async function runRecordedPromotion(runId: string): Promise<boolean> {
  const [row] = await db
    .select({ id: releaseAttempts.id })
    .from(releaseAttempts)
    .where(and(eq(releaseAttempts.runId, runId), eq(releaseAttempts.stage, 'promote')))
    .limit(1);
  return row !== undefined;
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

  // cm:guard a run that PROMOTED moves nothing and clears nothing. The roster is at `releasing`
  // over code that is on production, and both the status and the claim have to stay: the status
  // because no other one is true, and the claim because `release_batch_run_id` is the only index
  // onto these rows and an issue at `releasing` with no claim is unreachable by anything.
  const promoted = await runRecordedPromotion(runId);
  if (promoted) {
    logger.warn(
      { runId, claimed: claimed.length, reason: options.reason },
      'release-batch: this run promoted, so its roster stays at `releasing` for a person to settle',
    );
    await noteOnRoster(claimed, options, PROMOTED_NOTE);
    return {
      claimsCleared: [],
      recovered: [],
      destination: null,
      promoted: true,
    };
  }

  // cm:guard the destination is the project's OWN gate status and never a hardcoded one. An issue
  // this batch never promoted is still merged, still verified and still waiting for production —
  // which is what the gate status means — and `reopen` would say it had come back from a release
  // that did not happen. `reopen` remains for a project with no gate to go back to.
  const gateStatus = claimed[0] ? await resolveReleaseGate(claimed[0].projectId) : null;
  const destination: IssueStatus = gateStatus ?? 'reopen';

  const recovered: string[] = [];

  for (const issue of claimed) {
    if (issue.status !== 'releasing') continue;

    if (options.comment && options.actorUserId) {
      try {
        await db.insert(comments).values({
          issueId: issue.id,
          authorId: options.actorUserId,
          body: `${options.reason}. The issue is at \`${destination}\` — a person decides whether it goes back to work or into another batch.`,
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
        destination,
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

  return {
    claimsCleared: claimed.map((r) => r.id),
    recovered,
    destination: recovered.length > 0 ? destination : null,
    promoted: false,
  };
}

const PROMOTED_NOTE =
  'This batch recorded a promotion, so its issues stay at `releasing` and stay claimed: the code is on production and no status here is true except that one. Read the run with `GET /api/projects/{projectId}/release-batches/{runId}/state`, then either finish it if the release did land or settle each issue by hand.';

/**
 * Say on each issue what happened, without moving it.
 */
// cm:guard SILENCE here is the failure this replaces. A roster left at `releasing` with nothing on it reads as a release still running, which is the state ISS-923 measured 98 times; the comment is the only thing that makes it a situation somebody can find.
async function noteOnRoster(
  claimed: Array<{ id: string; status: string }>,
  options: RecoverStrandedReleasingOptions,
  note: string,
): Promise<void> {
  if (!options.comment || !options.actorUserId) return;
  for (const issue of claimed) {
    if (issue.status !== 'releasing') continue;
    try {
      await db.insert(comments).values({
        issueId: issue.id,
        authorId: options.actorUserId,
        body: `${options.reason}. ${note}`,
      });
    } catch (err) {
      logger.warn({ err, issueId: issue.id }, 'release-batch: promotion note failed');
    }
  }
}
