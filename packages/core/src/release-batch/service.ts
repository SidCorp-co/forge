// create: opens a system run, atomically claims N gate-status issues, marks each
// at its `release` step, enqueues one release_batch job. finish: closes every claimed
// issue and completes the run. abort: cancels the run and every job under it
// and closes no issue.
//
// Both outcomes take the run terminal, and by different outcomes: `completed`
// for a finish, `cancelled` for an abort. That is what stops
// `getActiveReleaseBatch` answering a batch whose work is over, and what
// keeps a finish from reading like an abort.
//
// finish and abort are the only writers that end the release step. Both hand the
// claim release to `releasing-recovery.ts`, which is also what a batch that
// died without either outcome goes through.

import { eq, inArray } from 'drizzle-orm';
import { db, type Tx } from '../db/client.js';
import { type IssueStatus, issues, type PipelineRunStatus, pipelineRuns } from '../db/schema.js';
import type { TransitionActor } from '../issues/actor-agency.js';
import { TransitionError, transitionIssueStatus } from '../issues/apply-transition.js';
import { claimIssuesForRelease } from '../issues/index.js';
import { activeIssuePrefix } from '../issues/issue-prefix-read.js';
import { setWorkStep } from '../issues/work-state.js';
import { formatIssueRef } from '../lib/issue-ref.js';
import { isRefusal } from '../lib/refusal.js';
import { logger } from '../observability/logger.js';
import { insertAndEnqueueJob } from '../pipeline/enqueue-helper.js';
import {
  cancelConcludedRun,
  closeRunIfOneShot,
  insertOneShotRun,
  type OneShotRunSpec,
} from '../pipeline/runs.js';
import {
  abortedError,
  batchAborted,
  closedBeforeAbort,
  settleAbortStamp,
  stampAbort,
} from './abort-stamp.js';
import { RELEASE_ROSTER_LIMIT } from './blocker-sentences.js';
import { collectReleaseBlockers } from './blockers.js';
import {
  type CloseVerification,
  closeVerification,
  type ReleaseVerification,
  resolveReleaseChannels,
  resolveReleasePlan,
} from './channel.js';
import { claimConflictAt, refuseLostReleaseClaim } from './claim-conflicts.js';
import { RELEASE_GATE_STATUS } from './gate.js';
import { RELEASE_BATCH_SKILL, releaseBranches } from './plan.js';
import { buildReleaseBatchPrompt } from './prompt.js';
import {
  blockerRefusal,
  FENCE_LOST,
  notVerifiedRefusal,
  reasonOf,
  refuseRelease,
  releaseBlockedRefusal,
} from './refuse.js';
import {
  type RecoverStrandedReleasingResult,
  recoverStrandedReleasing,
} from './releasing-recovery.js';
import { RELEASE_UNSTARTED_DEADLINE_MS } from './unstarted-recovery.js';
import { noteUnverifiedCloses, stampRunVerification } from './unverified-close.js';
import { liveCarriesRoster, readLiveCommit, verifyDeployed } from './verify.js';
import { cutReleaseVersion, markReleaseShipped } from './version-store.js';

export interface CreateReleaseBatchArgs {
  projectId: string;
  issueIds: string[];
  userId: string;
  /**
   * The version of a FAILED release being cut again. Raises the patch digit instead of the minor;
   * refused by name unless it names this project's highest release and that release never shipped.
   */
  recutOf?: string | undefined;
}

export interface CreateReleaseBatchResult {
  runId: string;
  jobId: string;
  issueIds: string[];
  gateStatus: IssueStatus;
  /** The version this release cut. Its identity from the instant its row existed. */
  version: string;
  /** When this batch must have an owner, or it is cancelled and its roster handed back. */
  ownerDeadlineAt: string;
  /**
   * Whether what was already serving when this batch opened carries a roster issue's merge — so
   * this release shipped before the batch recording it existed, and its finish will be earned by
   * identity rather than by a transition. Said here and not at the fifth finish (ISS-1199).
   */
  openedAfterRelease: boolean;
  /** `unverified` where production declares no source probe, which every issue it closes says. */
  verification: ReleaseVerification;
}

export async function createReleaseBatch(
  args: CreateReleaseBatchArgs,
): Promise<CreateReleaseBatchResult> {
  const { projectId, userId, recutOf } = args;

  // ISS-1127 — one enumerator, and this door refuses with every reason it found, the first first.
  const report = await collectReleaseBlockers(projectId, {
    issueIds: args.issueIds,
    door: 'batch',
  });
  if (!report.projectExists) throw blockerRefusal('NO_RELEASE_GATE');
  const refusal = releaseBlockedRefusal(report, args.issueIds);
  if (refusal) throw refusal;
  // Every id is now an issue at this project's gate, so its lower-case spelling is the row's own.
  const issueIds = args.issueIds.map((id) => id.toLowerCase());
  // After the report, so every project reason outranks it. An empty gate is
  // already `RELEASE_ROSTER_EMPTY` above; reaching here, issues are waiting and
  // this call named none of them, which is the caller's list to fix.
  if (issueIds.length === 0) {
    throw refuseRelease(
      'RELEASE_ISSUES_UNNAMED',
      `This call names no issue to release, and issues are waiting at the release gate. Send the ids GET /api/projects/${projectId}/release-batches/roster lists, oldest merge first, at most ${RELEASE_ROSTER_LIMIT} in one release.`,
      '/issueIds',
    );
  }

  const gateStatus = RELEASE_GATE_STATUS;
  const plan = await resolveReleasePlan(projectId);
  const preferenceMet = report.warnings.every((w) => w.code !== 'RELEASE_RUNNER_PREFERENCE_UNMET');
  if (!preferenceMet) {
    logger.warn(
      { projectId, releaseRunnerLabel: plan.releaseRunnerLabel },
      'release-batch: no box eligible to release carries the declared label, so this batch goes to the pool this project has',
    );
  }

  const decl = report.declaration;
  if (decl?.kind !== 'gated') throw blockerRefusal('NO_RELEASE_GATE');
  const { defaultBranch, promotePlanned } = releaseBranches(decl.path);
  const deployPlanned = plan.channels.length > 0;
  const verification = closeVerification(plan.channels);
  const commitBefore =
    verification.kind === 'probed' ? await readLiveCommit(verification.cfg) : null;

  const issueRows = await db
    .select({
      id: issues.id,
      issSeq: issues.issSeq,
      title: issues.title,
      mergedCommitSha: issues.mergedCommitSha,
    })
    .from(issues)
    .where(inArray(issues.id, issueIds));
  const openedAfterRelease = liveCarriesRoster(
    commitBefore,
    issueRows.map((r) => r.mergedCommitSha),
  );

  // The row and its version in ONE transaction: cutting the number after `openOneShotRun`
  // returned would leave a window, a crash in it, in which a committed release row has no
  // identity. `insertOneShotRun` takes its executor for exactly this.
  const runSpec: OneShotRunSpec = {
    projectId,
    kind: 'system',
    metadata: {
      source: 'release-batch',
      gateStatus,
      issueIds,
      deployPlanned,
      promotePlanned,
      commitBefore,
      openedAfterRelease,
      verification: verification.kind,
      releaseRunner: { label: plan.releaseRunnerLabel, preferenceMet },
    },
  };
  const { run, version } = await db.transaction(async (tx) => {
    const row = await insertOneShotRun(tx, runSpec);
    const cut = await cutReleaseVersion(tx, { runId: row.id, projectId, recutOf });
    return { run: row, version: cut };
  });

  const claimed = await claimIssuesForRelease({ projectId, issueIds, gateStatus, runId: run.id });

  if (claimed.length !== issueIds.length) {
    await closeRunIfOneShot(run.id, 'cancelled');
    throw await claimConflictAt(projectId, gateStatus, issueIds, claimed);
  }

  // ISS-54: a release run holding the issue is a step inside `awaiting_release`, not a status.
  for (const id of claimed.map((r) => r.id)) {
    try {
      await setWorkStep(db, id, 'release');
    } catch (err) {
      logger.warn(
        { err, issueId: id, runId: run.id },
        'release-batch: could not mark the release step',
      );
    }
  }

  const batchPrefix = await activeIssuePrefix(projectId);
  const promptString = buildReleaseBatchPrompt({
    runId: run.id,
    projectId,
    defaultBranch,
    path: decl.path,
    plan,
    releaseRunnerPreferenceMet: preferenceMet,
    issues: issueRows.map((r) => ({
      id: r.id,
      displayId: r.issSeq != null ? formatIssueRef(batchPrefix, r.issSeq) : r.id,
      title: r.title ?? '(untitled)',
    })),
  });

  let jobId: string;
  try {
    const result = await insertAndEnqueueJob({
      projectId,
      issueId: null,
      pipelineRunId: run.id,
      createdBy: userId,
      type: 'release_batch',
      skillName: RELEASE_BATCH_SKILL,
      promptString,
      payloadExtras: {
        releaseBatch: true,
        gateStatus,
        issueIds,
        timeoutSeconds: 3600,
      },
    });
    jobId = result.jobId;
  } catch (err) {
    if (isRefusal(err, 'ACTIVE_JOB_CONFLICT')) {
      await recoverStrandedReleasing(run.id, {
        reason: 'another batch was already in flight, so this one never started',
        actorUserId: userId,
      });
      await closeRunIfOneShot(run.id, 'cancelled');
      throw blockerRefusal('BATCH_IN_FLIGHT');
    }
    throw err;
  }

  return {
    runId: run.id,
    jobId,
    issueIds,
    gateStatus,
    version,
    ownerDeadlineAt: new Date(Date.now() + RELEASE_UNSTARTED_DEADLINE_MS).toISOString(),
    openedAfterRelease,
    verification: verification.kind,
  };
}

export interface FinishReleaseBatchResult {
  closed: string[];
  failed: Array<{ id: string; reason: string }>;
}

export interface FinishReleaseBatchOptions {
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

export type ReleaseRunRow = {
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

export async function finishReleaseBatch(
  runId: string,
  actor: TransitionActor,
  options: FinishReleaseBatchOptions = {},
): Promise<FinishReleaseBatchResult> {
  const run = await readReleaseRun(runId);

  const claimed = await db
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

  if (run) {
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
        issueIds: claimed.map((c) => c.id),
        actor,
        commit: options.commit ?? null,
      });
    }
  }

  const closed: string[] = [];
  const failed: Array<{ id: string; reason: string }> = [];

  const { fence } = options;
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
      await markReleaseShipped(runId, tx);
    });
  } else {
    await markReleaseShipped(runId);
  }

  const result = { closed, failed };
  await options.onClosed?.(result);
  await closeRunIfOneShot(runId, 'completed');

  return result;
}

/** What the recovery did to the roster, and what the abort did to the run row. `alreadyClosed` is
 *  every roster issue closed when the abort ran, claimed or not (`closedBeforeAbort`). */
export interface AbortReleaseBatchResult extends RecoverStrandedReleasingResult {
  run: {
    status: PipelineRunStatus | null;
    wasAlreadyTerminal: boolean;
    cancelledFrom: PipelineRunStatus | null;
  };
}

/**
 * What an abort does with a roster whose run already promoted.
 *
 * `hold` is the default: the code is on production, and the roster stays held at
 * `awaiting_release` at its `release` step. `return-to-gate` is the operator's route to terminal for
 * a batch that promoted and cannot verify, putting the roster back where
 * `POST /release-records` closes it against what production serves, with an
 * account (ISS-1199).
 */
export type PromotedRosterSettlement = 'hold' | 'return-to-gate';

export interface AbortReleaseBatchOptions {
  promotedRoster?: PromotedRosterSettlement | undefined;
  /** Test seam: runs after the roster is recovered and before its account is settled. */
  afterRosterRecovered?: (() => Promise<void>) | undefined;
}

export async function abortReleaseBatch(
  runId: string,
  reason: string,
  actorUserId: string,
  options: AbortReleaseBatchOptions = {},
): Promise<AbortReleaseBatchResult> {
  // First, so a finish sees the abort before the recovery and the cancel below (abort-stamp.ts).
  const stampId = await stampAbort(runId, {
    reason,
    by: actorUserId,
    holdPromotedRoster: options.promotedRoster !== 'return-to-gate',
  });
  const recovery = await recoverStrandedReleasing(runId, {
    reason: `batch release aborted: ${reason}`,
    actorUserId,
    comment: true,
    settlePromotedRoster: options.promotedRoster === 'return-to-gate',
  });
  await options.afterRosterRecovered?.();
  const held = recovery.promoted && options.promotedRoster !== 'return-to-gate';
  const roster = held ? 'held' : 'released';
  const alreadyClosed = await closedBeforeAbort(runId, recovery.alreadyClosed);
  await settleAbortStamp(runId, stampId, { roster, closed: alreadyClosed });

  await closeRunIfOneShot(runId, 'cancelled');

  const after = await cancelConcludedRun(runId);

  return {
    ...recovery,
    alreadyClosed,
    run: {
      status: after.cancelled ? 'cancelled' : after.was,
      wasAlreadyTerminal: after.cancelled,
      cancelledFrom: after.cancelled ? after.was : null,
    },
  };
}

export {
  type ActiveReleaseBatchInfo,
  findReleaseBatchRun,
  getActiveReleaseBatch,
  isOpenReleaseBatchRun,
  loadReleaseBatchContext,
  loadReleaseRoster,
  type ReleaseBatchContext,
  type ReleaseBatchIssue,
  type ReleaseRoster,
  type ReleaseRosterEntry,
} from './queries.js';
