// finish: closes every claimed issue once the probes agree, and completes the run. With abort it is
// the only writer that ends the release step; both hand the claims to `releasing-recovery.ts`.

import { eq } from 'drizzle-orm';
import { db, type Tx } from '../db/client.js';
import { type IssueStatus, issues, type PipelineRunStatus, pipelineRuns } from '../db/schema.js';
import type { TransitionActor } from '../issues/index.js';
import { TransitionError, transitionIssueStatus } from '../issues/index.js';
import { isRefusal } from '../lib/refusal.js';
import { logger } from '../observability/logger.js';
import { closeRunIfOneShot, stampReleaseShipped } from '../pipeline/index.js';
import { abortedError, batchAborted } from './abort-stamp.js';
import {
  type CloseVerification,
  closeVerification,
  type ReleaseVerification,
  resolveReleaseChannels,
} from './channel.js';
import { refuseLostReleaseClaim } from './claim-conflicts.js';
import { FENCE_LOST, notVerifiedRefusal, reasonOf, refuseRelease } from './refuse.js';
import { recoverStrandedReleasing } from './releasing-recovery.js';
import { noteUnverifiedCloses, stampRunVerification } from './unverified-close.js';
import { verifyDeployed } from './verify.js';

interface FinishReleaseBatchResult {
  closed: string[];
  failed: Array<{ id: string; reason: string }>;
}

interface FinishReleaseBatchOptions {
  /** The commit the release says it pushed, for the probes to match against. */
  commit?: string | undefined;
  /** An earlier worker on this same attempt already saw the probes go green, so they are not read again. */
  alreadyVerified?: boolean | undefined;
  whileVerifying?: (() => Promise<void>) | undefined;
  /** Called once verification is green — or, with no probe declared, once it is known there is
   *  none to read — before the first issue closes. */
  onVerified?: ((verification: ReleaseVerification) => Promise<void>) | undefined;
  /** Called with the roster's outcome before the claims are released, so it outlives them. */
  onRosterClosed?: ((result: FinishReleaseBatchResult) => Promise<void>) | undefined;
  /**
   * Run inside each closing write's own transaction, before it writes; throws to stop the close
   * where it stands. It holds the run row, so a takeover waits until that write has committed.
   */
  fence?: ((tx: Tx) => Promise<void>) | undefined;
  /**
   * Called with the outcome before the run goes terminal. The run's close cascade ends the
   * release job's own session, so anything that must be written about this finish is written here.
   */
  onClosed?: ((result: FinishReleaseBatchResult) => Promise<void>) | undefined;
}

type ReleaseRunRow = {
  projectId: string;
  metadata: unknown;
  status: PipelineRunStatus;
  releaseVersion: string | null;
};

/** The run a finish is about, or `undefined` when there is no row under that id. */
export async function readReleaseRun(runId: string): Promise<ReleaseRunRow | undefined> {
  const [run] = await db
    .select({
      projectId: pipelineRuns.projectId,
      metadata: pipelineRuns.metadata,
      status: pipelineRuns.status,
      releaseVersion: pipelineRuns.releaseVersion,
    })
    .from(pipelineRuns)
    .where(eq(pipelineRuns.id, runId))
    .limit(1);
  return run;
}

/**
 * Every refusal a finish can decide from the database alone, and how the release will be proved.
 * Nothing here makes an outbound request, so a door may call it inline.
 */
export async function assertFinishable(
  runId: string,
  run: ReleaseRunRow,
): Promise<CloseVerification> {
  if (batchAborted(run)) throw await abortedError(runId);
  // A release closes its roster claiming a ship; without a version nothing can name WHICH release
  // carried these issues, so it is refused by name. `createReleaseBatch` cuts the number in the
  // transaction that inserts the row, so a row reaching here without one was not opened by it.
  if (!run.releaseVersion) {
    throw refuseRelease(
      'RELEASE_VERSION_MISSING',
      `Release run ${runId} carries no version on its row, so it has no identity and nothing afterwards could name which release carried these issues. A release is given its version at the instant it is cut, so a run without one was never cut as a release. Abort this run and cut a new release.`,
    );
  }

  return closeVerification(await resolveReleaseChannels(run.projectId));
}

interface ClaimedRow {
  id: string;
  status: IssueStatus;
  reopenCount: number;
  projectId: string;
}

/** The probes agree the release is live — or there are none to read — and the run says which. */
async function verifyBeforeClose(
  runId: string,
  run: ReleaseRunRow,
  claimedIds: string[],
  actor: TransitionActor,
  options: FinishReleaseBatchOptions,
): Promise<void> {
  const verification = await assertFinishable(runId, run);
  if (verification.kind === 'probed' && !options.alreadyVerified) {
    const meta = (run.metadata ?? {}) as Record<string, unknown>;
    const outcome = await verifyDeployed({
      cfg: verification.cfg,
      commitBefore: typeof meta.commitBefore === 'string' ? meta.commitBefore : null,
      expected: options.commit ?? null,
      checkpoint: options.whileVerifying,
    });
    if (!outcome.ok) throw notVerifiedRefusal(outcome.reason, outcome.live);
    if (!outcome.moved) {
      logger.warn(
        { runId, identity: outcome.identity },
        'release-batch: the deployment was already serving this commit when the batch opened, so this is a release recorded after the fact rather than one this batch watched arrive',
      );
    }
  }
  await options.onVerified?.(verification.kind);
  await stampRunVerification(runId, verification.kind);
  if (verification.kind === 'unverified') {
    await noteUnverifiedCloses({
      runId,
      issueIds: claimedIds,
      actor,
      commit: options.commit ?? null,
    });
  }
}

/** Each claimed issue closed under the fence; one that will not close is named with its reason. */
async function closeRoster(
  claimed: ClaimedRow[],
  runId: string,
  actor: TransitionActor,
  fence: FinishReleaseBatchOptions['fence'],
): Promise<FinishReleaseBatchResult> {
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
      if (err instanceof TransitionError && err.code === 'NO_OP') {
        closed.push(issue.id);
      } else {
        logger.warn({ err, issueId: issue.id, runId }, 'release-batch: failed to close issue');
        failed.push({ id: issue.id, reason: reasonOf(err) });
      }
    }
  }
  return { closed, failed };
}

export async function finishReleaseBatch(
  runId: string,
  actor: TransitionActor,
  options: FinishReleaseBatchOptions = {},
): Promise<FinishReleaseBatchResult> {
  const run = await readReleaseRun(runId);

  const claimed: ClaimedRow[] = await db
    .select({
      id: issues.id,
      status: issues.status,
      reopenCount: issues.reopenCount,
      projectId: issues.projectId,
    })
    .from(issues)
    .where(eq(issues.releaseBatchRunId, runId));

  if (run?.status === 'completed' && claimed.length === 0) {
    const done = { closed: [], failed: [] };
    await options.onClosed?.(done);
    return done;
  }

  if (run)
    await verifyBeforeClose(
      runId,
      run,
      claimed.map((c) => c.id),
      actor,
      options,
    );

  const { fence } = options;
  const { closed, failed } = await closeRoster(claimed, runId, actor, fence);

  await options.onRosterClosed?.({ closed, failed });
  await recoverStrandedReleasing(runId, {
    reason: 'the release finished but this issue could not be closed',
    actorUserId: actor.type === 'user' ? actor.id : undefined,
    comment: true,
    fence,
  });

  // The ship, stamped on the release row itself. It is not read back off the run's status because
  // `cancelConcludedRun` flips a `completed` run to `cancelled`, and a release that shipped and was
  // aborted afterwards is still the one whose bytes are live.
  if (fence) {
    await db.transaction(async (tx) => {
      await fence(tx);
      await stampReleaseShipped(runId, tx);
    });
  } else {
    await stampReleaseShipped(runId);
  }

  const result = { closed, failed };
  await options.onClosed?.(result);
  await closeRunIfOneShot(runId, 'completed');

  return result;
}
