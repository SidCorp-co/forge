// create: opens a system run, atomically claims N tested issues, enqueues one
// release_batch job. finish: closes all claimed issues tested→closed. abort:
// releases claims, writes one comment per issue, closes nothing.
//
// RUNNER-CAP NOTE: the batch job holds its runner's single slot (nothing else
// deploys while a release is shipping). It does NOT count toward per-project
// maxConcurrentIssues (dispatch-gates.ts running_ids filters issue_id IS NOT NULL).

import { and, eq, inArray, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { comments, type IssueStatus, issues, pipelineRuns } from '../db/schema.js';
import {
  type TransitionActor,
  TransitionError,
  transitionIssueStatus,
} from '../issues/apply-transition.js';
import { logger } from '../logger.js';
import { ActiveJobConflictError, insertAndEnqueueJob } from '../pipeline/enqueue-helper.js';
import { closeRunIfOneShot, openOneShotRun } from '../pipeline/runs.js';
import { selectRunnerForJob } from '../runners/select.js';
import { resolveReleaseChannel, resolveReleaseDeviceIds, resolveReleasePlan } from './channel.js';
import { resolveReleaseGateStatus } from './gate.js';
import { loadProjectBranchConfig, loadProjectPipelineConfig } from './project-config.js';
import { buildReleaseBatchPrompt } from './prompt.js';
import { readLiveCommit, verifyDeployed } from './verify.js';

export class NoReleaseGateError extends Error {
  constructor() {
    super('NO_RELEASE_GATE');
    this.name = 'NoReleaseGateError';
  }
}

/**
 * The project named a release pool and no runner is in it. Distinct from
 * `NoRunnerOnlineError` on purpose: "nobody is online" and "the box that holds
 * the deploy credential lost its label" need different remedies.
 */
export class ReleasePoolEmptyError extends Error {
  constructor(public readonly label: string) {
    super('RELEASE_POOL_EMPTY');
    this.name = 'ReleasePoolEmptyError';
  }
}

export class NoRunnerOnlineError extends Error {
  constructor() {
    super('NO_RUNNER_ONLINE');
    this.name = 'NoRunnerOnlineError';
  }
}

/**
 * The probes did not agree that the release is live. `finish` refuses, so the
 * agent's only remaining move is `abort` — which is the point.
 */
export class ReleaseNotVerifiedError extends Error {
  constructor(
    public readonly reason: string,
    public readonly live: string | null,
  ) {
    super('RELEASE_NOT_VERIFIED');
    this.name = 'ReleaseNotVerifiedError';
  }
}

export class ClaimConflictError extends Error {
  constructor(public readonly issueIds: string[]) {
    super('CLAIM_CONFLICT');
    this.name = 'ClaimConflictError';
  }
}

export class BatchInFlightError extends Error {
  constructor(public readonly existingJobId: string | null) {
    super('BATCH_IN_FLIGHT');
    this.name = 'BatchInFlightError';
  }
}

export interface CreateReleaseBatchArgs {
  projectId: string;
  issueIds: string[];
  userId: string;
}

export interface CreateReleaseBatchResult {
  runId: string;
  jobId: string;
  issueIds: string[];
  gateStatus: IssueStatus;
}

export async function createReleaseBatch(
  args: CreateReleaseBatchArgs,
): Promise<CreateReleaseBatchResult> {
  const { projectId, issueIds, userId } = args;

  const cfg = await loadProjectPipelineConfig(projectId);
  const gateStatus = resolveReleaseGateStatus(cfg);
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

  const plan = await resolveReleasePlan(projectId);
  // cm:guard an empty pool must REFUSE, never fall back to the fleet: the pool exists because one box holds the production credential, and a release that lands anywhere else fails halfway through with the merge already pushed
  const allowDeviceIds = plan.releaseRunnerLabel
    ? await resolveReleaseDeviceIds(projectId, plan.releaseRunnerLabel)
    : null;
  if (allowDeviceIds && allowDeviceIds.length === 0) {
    throw new ReleasePoolEmptyError(plan.releaseRunnerLabel as string);
  }

  const runner = await selectRunnerForJob({ projectId, requiredCapabilities: {}, allowDeviceIds });
  if (!runner) throw new NoRunnerOnlineError();

  const branchCfg = await loadProjectBranchConfig(projectId);
  const baseBranch = branchCfg?.baseBranch ?? 'main';
  const productionBranch = branchCfg?.productionBranch ?? 'main';
  // cm:guard `deployPlanned` names the CHANNEL, not the branches. It used to mean "the branches differ", which reported a planned deploy to every project that promotes across branches and deploys nothing — and a planned deploy that cannot happen is the kind of claim this whole gate exists to remove.
  const deployPlanned = plan.provider !== null;
  const productionMergePlanned = productionBranch !== baseBranch;

  // cm:guard read the live commit BEFORE anything moves. Without this baseline a release that deployed nothing verifies perfectly: the probes answer, the commit matches what the agent reports, and what it reports is what was already serving.
  const commitBefore = plan.verify ? await readLiveCommit(plan.verify) : null;

  const run = await openOneShotRun({
    projectId,
    kind: 'system',
    metadata: {
      source: 'release-batch',
      gateStatus,
      issueIds,
      deployPlanned,
      productionMergePlanned,
      commitBefore,
    },
  });

  // cm:edge protocol -> packages/core/src/release-batch/routes.ts — this CAS UPDATE is the sole claim authority; issues.metadata is never used as a lock (see schema.ts guard)
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

  const issueRows = await db
    .select({ id: issues.id, issSeq: issues.issSeq, title: issues.title })
    .from(issues)
    .where(inArray(issues.id, issueIds));

  const promptString = buildReleaseBatchPrompt({
    runId: run.id,
    projectId,
    baseBranch,
    productionBranch,
    plan,
    issues: issueRows.map((r) => ({
      id: r.id,
      displayId: r.issSeq != null ? `ISS-${r.issSeq}` : r.id,
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
      skillName: 'forge-release-batch',
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
      await db.execute(sql`
        UPDATE issues SET release_batch_run_id = NULL, updated_at = now()
        WHERE release_batch_run_id = ${run.id}
      `);
      await closeRunIfOneShot(run.id, 'cancelled');
      throw new BatchInFlightError(err.existingJobId);
    }
    throw err;
  }

  return { runId: run.id, jobId, issueIds, gateStatus };
}

export interface ReleaseBatchIssue {
  id: string;
  displayId: string;
  title: string;
  releaseNotes: unknown;
  status: IssueStatus;
}

export interface ReleaseBatchContext {
  runId: string;
  projectId: string;
  gateStatus: IssueStatus;
  baseBranch: string;
  productionBranch: string;
  deployPlanned: boolean;
  productionMergePlanned: boolean;
  issues: ReleaseBatchIssue[];
}

export async function loadReleaseBatchContext(runId: string): Promise<ReleaseBatchContext | null> {
  const [run] = await db
    .select({
      id: pipelineRuns.id,
      projectId: pipelineRuns.projectId,
      metadata: pipelineRuns.metadata,
    })
    .from(pipelineRuns)
    .where(eq(pipelineRuns.id, runId))
    .limit(1);

  if (!run) return null;
  const meta = (run.metadata ?? {}) as Record<string, unknown>;
  if (meta.source !== 'release-batch') return null;

  const gateStatus = (meta.gateStatus as IssueStatus | undefined) ?? 'tested';
  const deployPlanned = (meta.deployPlanned as boolean | undefined) ?? false;
  const productionMergePlanned = (meta.productionMergePlanned as boolean | undefined) ?? false;

  const branchCfg = await loadProjectBranchConfig(run.projectId);
  const baseBranch = branchCfg?.baseBranch ?? 'main';
  const productionBranch = branchCfg?.productionBranch ?? 'main';

  const claimedIssues = await db
    .select({
      id: issues.id,
      issSeq: issues.issSeq,
      title: issues.title,
      releaseNotes: issues.releaseNotes,
      status: issues.status,
    })
    .from(issues)
    .where(eq(issues.releaseBatchRunId, runId));

  return {
    runId,
    projectId: run.projectId,
    gateStatus,
    baseBranch,
    productionBranch,
    deployPlanned,
    productionMergePlanned,
    issues: claimedIssues.map((r) => ({
      id: r.id,
      displayId: r.issSeq != null ? `ISS-${r.issSeq}` : r.id,
      title: r.title ?? '(untitled)',
      releaseNotes: r.releaseNotes,
      status: r.status,
    })),
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
    .select({ projectId: pipelineRuns.projectId, metadata: pipelineRuns.metadata })
    .from(pipelineRuns)
    .where(eq(pipelineRuns.id, runId))
    .limit(1);

  if (run) {
    const channel = await resolveReleaseChannel(run.projectId);
    if (channel.verify) {
      const meta = (run.metadata ?? {}) as Record<string, unknown>;
      const outcome = await verifyDeployed({
        cfg: channel.verify,
        commitBefore: typeof meta.commitBefore === 'string' ? meta.commitBefore : null,
        expected: options.commit ?? null,
      });
      // cm:guard refuse BEFORE closing anything. A partial close would leave some issues claiming a release the probes just said did not happen, and nothing walks that back.
      if (!outcome.ok) throw new ReleaseNotVerifiedError(outcome.reason, outcome.live);
    }
  }

  const claimed = await db
    .select({
      id: issues.id,
      status: issues.status,
      reopenCount: issues.reopenCount,
      projectId: issues.projectId,
    })
    .from(issues)
    .where(eq(issues.releaseBatchRunId, runId));

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
        // cm:edge protocol -> packages/core/src/issues/release-gate-hold.ts — the ONLY caller allowed to pass this. It is what makes `finish` the single writer of `closed` past the gate; an agent's own close is rewritten back to the gate without it
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

  await db.execute(sql`
    UPDATE issues SET release_batch_run_id = NULL, updated_at = now()
    WHERE release_batch_run_id = ${runId}
  `);

  return { closed, failed };
}

export async function abortReleaseBatch(
  runId: string,
  reason: string,
  actorUserId: string,
): Promise<string[]> {
  const released = await db.execute<{ id: string; issue_id_col: string }>(sql`
    UPDATE issues SET release_batch_run_id = NULL, updated_at = now()
    WHERE release_batch_run_id = ${runId}
    RETURNING id
  `);

  const releasedIds = released.map((r) => r.id);

  for (const issueId of releasedIds) {
    try {
      await db.insert(comments).values({
        issueId,
        authorId: actorUserId,
        body: `Batch release aborted: ${reason}. Issue remains at its current status and can be re-selected for a future batch release.`,
        isAi: true,
      });
    } catch (err) {
      logger.warn({ err, issueId, runId }, 'release-batch: failed to write abort comment');
    }
  }

  return releasedIds;
}

// cm:edge naming -> packages/core/src/release-batch/queries.ts — every caller imports the batch surface from this module; the read-only half lives next door for the size budget, and re-exporting keeps that a file layout rather than an API change
export {
  type ActiveReleaseBatchInfo,
  getActiveReleaseBatch,
  isOpenReleaseBatchRun,
  loadReleaseRoster,
  type ReleaseRoster,
  type ReleaseRosterEntry,
} from './queries.js';
