// The one door that writes `releasing` (ISS-1421): a new batch's roster is claimed for its run and
// moved there in ONE transaction, each move the chokepoint's own write, so either the whole roster
// stands at Releasing under a running run or none of it does and the run is cancelled.

import { userActor } from '../comments/forge-author.js';
import { db } from '../db/client.js';
import type { IssueStatus } from '../db/schema.js';
import {
  type StagedTransition,
  stageIssueTransition,
  TransitionError,
} from '../issues/apply-transition.js';
import { closeRunIfOneShot } from '../pipeline/runs.js';
import { claimConflictAt } from './claim-conflicts.js';
import { ReleaseRosterRefusedError } from './errors.js';

/** One roster issue's refused move, carried out of the roster's transaction so it rolls back. */
class RosterMoveRefused extends Error {
  constructor(
    readonly issueId: string,
    readonly refusal: TransitionError,
  ) {
    super(refusal.message);
  }
}

/**
 * Claim the whole roster for `runId` and move it to Releasing, in ONE transaction: each move is the
 * chokepoint's own write, claiming its issue in the same statement, and one refusal rolls every move
 * back and cancels the run (ISS-1421). The moves' effects are published once the transaction commits.
 */
export async function enterReleasing(args: {
  projectId: string;
  gateStatus: IssueStatus;
  issueIds: string[];
  runId: string;
  userId: string;
}): Promise<void> {
  const { projectId, gateStatus, issueIds, runId, userId } = args;
  let staged: StagedTransition[];
  try {
    staged = await db.transaction(async (tx) => {
      const out: StagedTransition[] = [];
      for (const id of issueIds) {
        try {
          out.push(
            await stageIssueTransition(
              { id, projectId, status: gateStatus, reopenCount: 0 },
              'releasing',
              userActor(userId),
              { releaseRun: runId },
              tx,
            ),
          );
        } catch (err) {
          throw err instanceof TransitionError ? new RosterMoveRefused(id, err) : err;
        }
      }
      return out;
    });
  } catch (failure) {
    await closeRunIfOneShot(runId, 'cancelled');
    if (!(failure instanceof RosterMoveRefused)) throw failure;
    const { issueId, refusal } = failure;
    if (refusal.code === 'STALE_TRANSITION') {
      throw await claimConflictAt(projectId, gateStatus, issueIds, []);
    }
    throw new ReleaseRosterRefusedError(issueId, refusal.code, refusal.detail);
  }
  for (const move of staged) await move.publish();
}
