// create: opens a system run, atomically claims N gate-status issues, moves each
// to `releasing`, enqueues one release_batch job. finish: closes every claimed
// issue and completes the run. abort: cancels the run and every job under it
// and closes no issue.
//
// Both outcomes take the run terminal, and by different outcomes: `completed`
// for a finish, `cancelled` for an abort. That is what stops
// `getActiveReleaseBatch` answering a batch whose work is over, and what
// keeps a finish from reading like an abort.
//
// finish and abort are the only writers that leave `releasing`. Both hand the
// claim release to `releasing-recovery.ts`, which is also what a batch that
// died without either outcome goes through.

import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import { db, type Tx } from '../db/client.js';
import {
  type IssueStatus,
  issues,
  jobs,
  type PipelineRunStatus,
  pipelineRuns,
} from '../db/schema.js';
import type { TransitionActor } from '../issues/actor-agency.js';
import { TransitionError, transitionIssueStatus } from '../issues/apply-transition.js';
import { activeIssuePrefix } from '../issues/issue-prefix-read.js';
import { formatIssueRef } from '../lib/issue-ref.js';
import { logger } from '../logger.js';
import { ActiveJobConflictError, insertAndEnqueueJob } from '../pipeline/enqueue-helper.js';
import {
  announceOneShotRun,
  cancelConcludedRun,
  closeRunIfOneShot,
  insertOneShotRun,
  type OneShotRunSpec,
} from '../pipeline/runs.js';
import { readProjectBranches } from '../projects/service.js';
import { abortedError, batchAborted, stampAbort } from './abort-stamp.js';
import { collectReleaseBlockers, releaseBlockerError } from './blockers.js';
import { resolveReleaseChannels, resolveReleasePlan } from './channel.js';
import {
  BatchInFlightError,
  ClaimConflictError,
  NoReleaseGateError,
  ReleaseFinishFenceLostError,
  ReleaseIssuesUnnamedError,
  ReleaseNotVerifiedError,
  ReleaseProbesUndeclaredError,
  ReleaseVersionMissingError,
} from './errors.js';
import { RELEASE_GATE_STATUS } from './gate.js';
import { assertMethodFor, readMethod } from './method.js';
import { RELEASE_BATCH_SKILL, ReleaseBranchesUndeclaredError, releaseBranches } from './plan.js';
import { buildReleaseBatchPrompt } from './prompt.js';
import { recoverStrandedReleasing } from './releasing-recovery.js';
import { RELEASE_UNSTARTED_DEADLINE_MS } from './unstarted-recovery.js';
import { liveCarriesRoster, readLiveCommit, type VerifyConfig, verifyDeployed } from './verify.js';
import { cutReleaseVersion, markReleaseShipped } from './version-store.js';

export * from './errors.js';
export { ReleaseBranchesUndeclaredError };
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
}

export async function createReleaseBatch(
  args: CreateReleaseBatchArgs,
): Promise<CreateReleaseBatchResult> {
  const { projectId, issueIds, userId, recutOf } = args;

  // ISS-1127 — one enumerator, and this door throws its FIRST answer. Every
  // refusal keeps the class, the code and the wording it had; what is new is
  // that the error carries the rest of the list, so an operator clearing this
  // one already knows what else is standing.
  const report = await collectReleaseBlockers(projectId, { issueIds, door: 'batch' });
  if (!report.projectExists) throw new NoReleaseGateError();
  const refusal = releaseBlockerError(report);
  if (refusal) throw refusal;
  // After the report, so every project reason outranks it. An empty gate is
  // already `RELEASE_ROSTER_EMPTY` above; reaching here, issues are waiting and
  // this call named none of them, which is the caller's list to fix.
  if (issueIds.length === 0) throw new ReleaseIssuesUnnamedError();

  const gateStatus = RELEASE_GATE_STATUS;
  const plan = await resolveReleasePlan(projectId);
  const preferenceMet = report.warnings.every((w) => w.code !== 'RELEASE_RUNNER_PREFERENCE_UNMET');
  if (!preferenceMet) {
    logger.warn(
      { projectId, releaseRunnerLabel: plan.releaseRunnerLabel },
      'release-batch: no box eligible to release carries the declared label, so this batch goes to the pool this project has',
    );
  }

  const project = (await readProjectBranches(projectId)) ?? {
    baseBranch: null,
    liveBranch: null,
    releaseModel: 'none' as const,
    releaseStrategy: null,
  };
  const { baseBranch, liveBranch, promotePlanned } = releaseBranches(project, project.releaseModel);
  const deployPlanned = plan.channels.length > 0;
  const firstVerify = plan.channels[0]?.verify ?? null;
  const commitBefore = firstVerify ? await readLiveCommit(firstVerify) : null;

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

  // The row and its version in ONE transaction, and the announcement after it commits. Cutting
  // the number after `openOneShotRun` returned would leave a window — a crash in it, and a
  // subscriber reading the announcement during it — in which a committed release row has no
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
      releaseRunner: { label: plan.releaseRunnerLabel, preferenceMet },
    },
  };
  const { run, version } = await db.transaction(async (tx) => {
    const row = await insertOneShotRun(tx, runSpec);
    const cut = await cutReleaseVersion(tx, { runId: row.id, projectId, recutOf });
    return { run: row, version: cut };
  });
  await announceOneShotRun(run.id, runSpec);

  const claimed = await db.execute<{ id: string }>(sql`
    UPDATE issues
    SET release_batch_run_id = ${run.id}, updated_at = now()
    WHERE project_id = ${projectId}
      AND id IN (${sql.join(
        issueIds.map((id) => sql`${id}`),
        sql`, `,
      )})
      AND status = ${gateStatus}
      AND release_batch_run_id IS NULL
    RETURNING id
  `);

  if (claimed.length !== issueIds.length) {
    await closeRunIfOneShot(run.id, 'cancelled');
    throw new ClaimConflictError(issueIds.filter((id) => !claimed.some((r) => r.id === id)));
  }

  for (const id of claimed.map((r) => r.id)) {
    try {
      await transitionIssueStatus(
        { id, projectId, status: gateStatus, reopenCount: 0 },
        'releasing',
        { type: 'user', id: userId },
        { viaReleasePath: true },
      );
    } catch (err) {
      if (!(err instanceof TransitionError && err.code === 'NO_OP')) {
        logger.warn({ err, issueId: id, runId: run.id }, 'release-batch: could not mark releasing');
      }
    }
  }

  const batchPrefix = await activeIssuePrefix(projectId);
  const promptString = buildReleaseBatchPrompt({
    runId: run.id,
    projectId,
    baseBranch,
    liveBranch,
    releaseModel: project.releaseModel,
    releaseStrategy: project.releaseStrategy,
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
    if (err instanceof ActiveJobConflictError) {
      await recoverStrandedReleasing(run.id, {
        reason: 'another batch was already in flight, so this one never started',
        actorUserId: userId,
      });
      await closeRunIfOneShot(run.id, 'cancelled');
      throw new BatchInFlightError(err.existingJobId);
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
  /** Awaited before each probe read while verifying; throws to stop the verification there. */
  whileVerifying?: (() => Promise<void>) | undefined;
  /** Called once verification is green, before the first issue closes. */
  onVerified?: (() => Promise<void>) | undefined;
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
 * Every refusal a finish can decide from the database alone, and the probe declaration the
 * verification will read. Nothing here makes an outbound request, so a door may call it inline.
 */
export async function assertFinishable(runId: string, run: ReleaseRunRow): Promise<VerifyConfig> {
  if (batchAborted(run)) throw await abortedError(runId);
  // A release closes its roster claiming a ship. Without a version nothing afterwards can name
  // WHICH release carried these issues, which is the one thing this path exists to make true, so
  // it is refused by name rather than closed anyway. `createReleaseBatch` cuts the number inside
  // the transaction that inserts the row, so a release row reaching here without one was not
  // opened by it.
  if (!run.releaseVersion) throw new ReleaseVersionMissingError(runId);

  const [job] = await db
    .select({ payload: jobs.payload })
    .from(jobs)
    .where(and(eq(jobs.pipelineRunId, runId), eq(jobs.type, 'release_batch')))
    .orderBy(desc(jobs.queuedAt))
    .limit(1);
  const jobSkill = (job?.payload as { skillName?: unknown } | null)?.skillName;
  assertMethodFor(
    readMethod(run.metadata),
    typeof jobSkill === 'string' && jobSkill.length > 0 ? jobSkill : RELEASE_BATCH_SKILL,
  );

  const channels = await resolveReleaseChannels(run.projectId);
  const closeVerify = channels[0]?.verify ?? null;
  if (channels.length === 0 || channels.some((c) => !c.verify) || !closeVerify) {
    throw new ReleaseProbesUndeclaredError();
  }
  return closeVerify;
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
    const closeVerify = await assertFinishable(runId, run);
    if (!options.alreadyVerified) {
      const meta = (run.metadata ?? {}) as Record<string, unknown>;
      const outcome = await verifyDeployed({
        cfg: closeVerify,
        commitBefore: typeof meta.commitBefore === 'string' ? meta.commitBefore : null,
        expected: options.commit ?? null,
        checkpoint: options.whileVerifying,
      });
      if (!outcome.ok) throw new ReleaseNotVerifiedError(outcome.reason, outcome.live);
      if (!outcome.moved) {
        logger.warn(
          { runId, identity: outcome.identity },
          'release-batch: the deployment was already serving this commit when the batch opened, so this is a release recorded after the fact rather than one this batch watched arrive',
        );
      }
    }
    await options.onVerified?.();
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
        { viaReleasePath: true, ...(fence ? { beforeStatusWrite: fence } : {}) },
      );
      closed.push(issue.id);
    } catch (err) {
      if (err instanceof ReleaseFinishFenceLostError) throw err;
      if (err instanceof TransitionError && err.code === 'NO_OP') {
        closed.push(issue.id);
      } else {
        logger.warn({ err, issueId: issue.id, runId }, 'release-batch: failed to close issue');
        failed.push({ id: issue.id, reason: err instanceof Error ? err.message : String(err) });
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

export interface AbortReleaseBatchResult {
  claimsCleared: string[];
  /** Where the roster went, or `null` when nothing moved. */
  destination: IssueStatus | null;
  /** True when the run had promoted. On its own it no longer says the roster stayed put:
   *  `promotedRoster: 'return-to-gate'` settles one anyway, and `destination` is what moved. */
  promoted: boolean;
  /** What the abort did to the run row, in its own words. */
  run: {
    status: PipelineRunStatus | null;
    wasAlreadyTerminal: boolean;
    cancelledFrom: PipelineRunStatus | null;
  };
}

/**
 * What an abort does with a roster whose run already promoted.
 *
 * `hold` is the default: the code is on production and no status here is true
 * except `releasing`. `return-to-gate` is the operator's route to terminal for
 * a batch that promoted and cannot verify, putting the roster back where
 * `POST /release-records` closes it against what production serves, with an
 * account (ISS-1199).
 */
export type PromotedRosterSettlement = 'hold' | 'return-to-gate';

export interface AbortReleaseBatchOptions {
  promotedRoster?: PromotedRosterSettlement | undefined;
  /** Test seam: runs after the roster is recovered and before the run is cancelled. */
  afterRosterRecovered?: (() => Promise<void>) | undefined;
}

export async function abortReleaseBatch(
  runId: string,
  reason: string,
  actorUserId: string,
  options: AbortReleaseBatchOptions = {},
): Promise<AbortReleaseBatchResult> {
  // First, so a finish attempt sees the abort from here on: the run is cancelled only after the
  // roster is recovered, because the run-close hook would otherwise race this recovery.
  await stampAbort(runId, {
    reason,
    by: actorUserId,
    holdPromotedRoster: options.promotedRoster !== 'return-to-gate',
  });
  const { claimsCleared, destination, promoted } = await recoverStrandedReleasing(runId, {
    reason: `batch release aborted: ${reason}`,
    actorUserId,
    comment: true,
    settlePromotedRoster: options.promotedRoster === 'return-to-gate',
  });
  await options.afterRosterRecovered?.();

  await closeRunIfOneShot(runId, 'cancelled');

  const after = await cancelConcludedRun(runId);

  return {
    claimsCleared,
    destination,
    promoted,
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
