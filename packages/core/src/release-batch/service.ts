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
import { db } from '../db/client.js';
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
import { issuesMissingReleaseRecord } from '../issues/release-record-required.js';
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
import { onlineCapableDeviceIds } from '../runners/select.js';
import {
  projectRunnerDeviceIds,
  resolveReleaseChannels,
  resolveReleaseDeviceIds,
  resolveReleasePlan,
} from './channel.js';
import {
  BatchInFlightError,
  ClaimConflictError,
  NoReleaseGateError,
  NoRunnerOnlineError,
  ReleaseBatchAbortedError,
  ReleaseMultiChannelUnsupportedError,
  ReleaseNotVerifiedError,
  ReleasePoolEmptyError,
  ReleaseProbesUndeclaredError,
  ReleaseRecordMissingError,
  ReleaseRunnerUndeclaredError,
  ReleaseVersionMissingError,
} from './errors.js';
import { resolveReleaseGate } from './gate.js';
import { assertMethodFor, readMethod } from './method.js';
import { RELEASE_BATCH_SKILL, ReleaseBranchesUndeclaredError, releaseBranches } from './plan.js';
import { buildReleaseBatchPrompt } from './prompt.js';
import { recoverStrandedReleasing } from './releasing-recovery.js';
import { RELEASE_UNSTARTED_DEADLINE_MS } from './unstarted-recovery.js';
import { readLiveCommit, verifyDeployed } from './verify.js';
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
}

export async function createReleaseBatch(
  args: CreateReleaseBatchArgs,
): Promise<CreateReleaseBatchResult> {
  const { projectId, issueIds, userId, recutOf } = args;

  const gateStatus = await resolveReleaseGate(projectId);
  if (!gateStatus) throw new NoReleaseGateError();

  const preflightRows = await db
    .select({ id: issues.id, status: issues.status, releaseBatchRunId: issues.releaseBatchRunId })
    .from(issues)
    .where(and(eq(issues.projectId, projectId), inArray(issues.id, issueIds)));

  const foundIds = new Set(preflightRows.map((r) => r.id));
  const notFound = issueIds.filter((id) => !foundIds.has(id));
  if (notFound.length > 0) throw new ClaimConflictError(notFound);

  const notClaimable = preflightRows.filter(
    (r) => r.status !== gateStatus || r.releaseBatchRunId !== null,
  );
  if (notClaimable.length > 0) throw new ClaimConflictError(notClaimable.map((r) => r.id));

  const unrecorded = await issuesMissingReleaseRecord(issueIds);
  if (unrecorded.length > 0) throw new ReleaseRecordMissingError(unrecorded);

  const plan = await resolveReleasePlan(projectId);
  if (!plan.releaseRunnerLabel) throw new ReleaseRunnerUndeclaredError();
  if (plan.channels.some((c) => !c.verify)) throw new ReleaseProbesUndeclaredError();
  // ISS-1128 — the label RANKS this pool. Boxes carrying it go first; where
  // none of them can take the release, the pool is the fleet rather than
  // nobody, and the unmet preference is recorded rather than dropped.
  const labelled = await resolveReleaseDeviceIds(projectId, plan.releaseRunnerLabel);
  const preferred =
    labelled.length === 0
      ? []
      : await onlineCapableDeviceIds(projectId, {}, { allowDeviceIds: labelled });
  const preferenceMet = preferred.length > 0;
  const releasePool = preferenceMet ? preferred : await onlineCapableDeviceIds(projectId, {});
  if (releasePool.length === 0) {
    if ((await projectRunnerDeviceIds(projectId)).length === 0) throw new ReleasePoolEmptyError();
    throw new NoRunnerOnlineError();
  }
  if (!preferenceMet) {
    logger.warn(
      { projectId, releaseRunnerLabel: plan.releaseRunnerLabel, releasePool },
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

  if (plan.channels.length > 1) throw new ReleaseMultiChannelUnsupportedError(plan.channels.length);
  const firstVerify = plan.channels[0]?.verify ?? null;
  const commitBefore = firstVerify ? await readLiveCommit(firstVerify) : null;

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

  const issueRows = await db
    .select({ id: issues.id, issSeq: issues.issSeq, title: issues.title })
    .from(issues)
    .where(inArray(issues.id, issueIds));

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
  };
}

export interface FinishReleaseBatchResult {
  closed: string[];
  failed: Array<{ id: string; reason: string }>;
}

export interface FinishReleaseBatchOptions {
  /** The commit the release says it pushed, for the probes to match against. */
  commit?: string | undefined;
}

export async function finishReleaseBatch(
  runId: string,
  actor: TransitionActor,
  options: FinishReleaseBatchOptions = {},
): Promise<FinishReleaseBatchResult> {
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

  const claimed = await db
    .select({
      id: issues.id,
      status: issues.status,
      reopenCount: issues.reopenCount,
      projectId: issues.projectId,
    })
    .from(issues)
    .where(eq(issues.releaseBatchRunId, runId));

  if (run?.status === 'completed' && claimed.length === 0) return { closed: [], failed: [] };

  if (run?.status === 'cancelled') throw new ReleaseBatchAbortedError();

  if (run) {
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
    const meta = (run.metadata ?? {}) as Record<string, unknown>;
    const outcome = await verifyDeployed({
      cfg: closeVerify,
      commitBefore: typeof meta.commitBefore === 'string' ? meta.commitBefore : null,
      expected: options.commit ?? null,
    });
    if (!outcome.ok) throw new ReleaseNotVerifiedError(outcome.reason, outcome.live);
  }

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
        { viaReleasePath: true },
      );
      closed.push(issue.id);
    } catch (err) {
      if (err instanceof TransitionError && err.code === 'NO_OP') {
        closed.push(issue.id);
      } else {
        logger.warn({ err, issueId: issue.id, runId }, 'release-batch: failed to close issue');
        failed.push({ id: issue.id, reason: err instanceof Error ? err.message : String(err) });
      }
    }
  }

  await recoverStrandedReleasing(runId, {
    reason: 'the release finished but this issue could not be closed',
    actorUserId: actor.type === 'user' ? actor.id : undefined,
    comment: true,
  });

  // The ship, stamped on the release row itself. It is not read back off the run's status because
  // `cancelConcludedRun` flips a `completed` run to `cancelled`, and a release that shipped and was
  // aborted afterwards is still the one whose bytes are live.
  await markReleaseShipped(runId);

  await closeRunIfOneShot(runId, 'completed');

  return { closed, failed };
}

export interface AbortReleaseBatchResult {
  claimsCleared: string[];
  /** Where the roster went, or `null` when nothing moved. */
  destination: IssueStatus | null;
  /** True when the run had promoted, so the roster stayed at `releasing`. */
  promoted: boolean;
  /** What the abort did to the run row, in its own words. */
  run: {
    status: PipelineRunStatus | null;
    wasAlreadyTerminal: boolean;
    cancelledFrom: PipelineRunStatus | null;
  };
}

export async function abortReleaseBatch(
  runId: string,
  reason: string,
  actorUserId: string,
): Promise<AbortReleaseBatchResult> {
  const { claimsCleared, destination, promoted } = await recoverStrandedReleasing(runId, {
    reason: `batch release aborted: ${reason}`,
    actorUserId,
    comment: true,
  });

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
