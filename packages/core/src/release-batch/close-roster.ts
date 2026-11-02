// Closing a release's claimed issues, one write each under the finish's fence: the one closer a
// finish, a change-request settle and a shipped-in record share (`shipped-in.ts`), kept apart from
// `finish.ts` so a shipped-in record made at a finish imports no cycle.

import type { Tx } from '../db/client.js';
import type { IssueStatus } from '../db/schema.js';
import type { TransitionActor } from '../issues/index.js';
import { transitionIssueStatus } from '../issues/index.js';
import { logger } from '../lib/logger.js';
import { isRefusal } from '../lib/refusal.js';
import { refuseLostReleaseClaim } from './claim-conflicts.js';
import { FENCE_LOST, reasonOf } from './refuse.js';

export interface ClaimedRow {
  id: string;
  status: IssueStatus;
  reopenCount: number;
  projectId: string;
}

export interface RosterCloseResult {
  closed: string[];
  failed: Array<{ id: string; reason: string }>;
}

/**
 * Run inside each closing write's own transaction, before it writes; throws to stop the close
 * where it stands. It holds the run row, so a takeover waits until that write has committed.
 */
export type RosterFence = ((tx: Tx) => Promise<void>) | undefined;

/** Each claimed issue closed under the fence; one that will not close is named with its reason. */
export async function closeRoster(
  claimed: ClaimedRow[],
  runId: string,
  actor: TransitionActor,
  fence: RosterFence,
): Promise<RosterCloseResult> {
  const closed: string[] = [];
  const failed: Array<{ id: string; reason: string }> = [];

  for (const issue of claimed) {
    try {
      await transitionIssueStatus(
        {
          id: issue.id,
          projectId: issue.projectId,
          status: issue.status,
          reopenCount: issue.reopenCount,
        },
        'closed',
        actor,
        {
          beforeStatusWrite: async (tx) => {
            await fence?.(tx);
            await refuseLostReleaseClaim(tx, issue.id, runId);
          },
        },
      );
      closed.push(issue.id);
    } catch (err) {
      if (isRefusal(err, FENCE_LOST)) throw err;
      if (isRefusal(err, 'NO_OP')) {
        closed.push(issue.id);
      } else {
        logger.warn({ err, issueId: issue.id, runId }, 'release-batch: failed to close issue');
        failed.push({ id: issue.id, reason: reasonOf(err) });
      }
    }
  }
  return { closed, failed };
}
