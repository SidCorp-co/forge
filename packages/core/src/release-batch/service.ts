// create: opens a system run, atomically claims N tested issues, enqueues one
// release_batch job. finish: closes all claimed issues tested→closed. abort:
// releases claims, writes one comment per issue, closes nothing.
//
// RUNNER-CAP NOTE: the batch job holds its runner's single slot (nothing else
// deploys while a release is shipping). It does NOT count toward per-project
// maxConcurrentIssues (dispatch-gates.ts running_ids filters issue_id IS NOT NULL).

import { and, eq, inArray, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { type IssueStatus, comments, issues, pipelineRuns, projects } from '../db/schema.js';
import {
  type TransitionActor,
  TransitionError,
  transitionIssueStatus,
} from '../issues/apply-transition.js';
import { logger } from '../logger.js';
import { ActiveJobConflictError, insertAndEnqueueJob } from '../pipeline/enqueue-helper.js';
import {
  PIPELINE_CONFIG_DEFAULTS,
  type PipelineConfig,
  pipelineConfigSchema,
} from '../pipeline/pipeline-config-schema.js';
import { closeRunIfOneShot, openOneShotRun } from '../pipeline/runs.js';
import { selectRunnerForJob } from '../runners/select.js';
import { resolveReleaseGateStatus } from './gate.js';
import { buildReleaseBatchPrompt } from './prompt.js';

export class NoReleaseGateError extends Error {
  constructor() {
    super('NO_RELEASE_GATE');
    this.name = 'NoReleaseGateError';
  }
}

export class NoRunnerOnlineError extends Error {
  constructor() {
    super('NO_RUNNER_ONLINE');
    this.name = 'NoRunnerOnlineError';
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

async function loadProjectPipelineConfig(projectId: string): Promise<PipelineConfig | null> {
  const [row] = await db
    .select({ agentConfig: projects.agentConfig })
    .from(projects)
    .where(eq(projects.id, projectId))
    .limit(1);
  if (!row) return null;
  const ac = (row.agentConfig as { pipelineConfig?: unknown } | null) ?? {};
  const parsed = pipelineConfigSchema.safeParse(ac.pipelineConfig ?? {});
  if (!parsed.success) return { ...PIPELINE_CONFIG_DEFAULTS };
  return parsed.data;
}

async function loadProjectBranchConfig(
  projectId: string,
): Promise<{ baseBranch: string; productionBranch: string } | null> {
  const [row] = await db
    .select({ agentConfig: projects.agentConfig })
    .from(projects)
    .where(eq(projects.id, projectId))
    .limit(1);
  if (!row) return null;
  const ac = (row.agentConfig as Record<string, unknown> | null) ?? {};
  const bc = (ac.branchConfig as Record<string, unknown> | undefined) ?? {};
  return {
    baseBranch: (bc.baseBranch as string | undefined) ?? 'main',
    productionBranch: (bc.productionBranch as string | undefined) ?? 'main',
  };
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

  const runner = await selectRunnerForJob({ projectId, requiredCapabilities: {} });
  if (!runner) throw new NoRunnerOnlineError();

  const branchCfg = await loadProjectBranchConfig(projectId);
  const baseBranch = branchCfg?.baseBranch ?? 'main';
  const productionBranch = branchCfg?.productionBranch ?? 'main';
  const deployPlanned = productionBranch !== baseBranch;

  const run = await openOneShotRun({
    projectId,
    kind: 'system',
    metadata: { source: 'release-batch', gateStatus, issueIds, deployPlanned },
  });

  // cm:edge protocol -> packages/core/src/release-batch/routes.ts — this CAS UPDATE is the sole claim authority; issues.metadata is never used as a lock (see schema.ts guard)
  const claimed = await db.execute<{ id: string }>(sql`
    UPDATE issues
    SET release_batch_run_id = ${run.id}, updated_at = now()
    WHERE project_id = ${projectId}
      AND id = ANY(${issueIds}::uuid[])
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

export async function finishReleaseBatch(
  runId: string,
  actor: TransitionActor,
): Promise<FinishReleaseBatchResult> {
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

export async function isOpenReleaseBatchRun(projectId: string, runId: string): Promise<boolean> {
  const [run] = await db
    .select({
      projectId: pipelineRuns.projectId,
      kind: pipelineRuns.kind,
      status: pipelineRuns.status,
      metadata: pipelineRuns.metadata,
    })
    .from(pipelineRuns)
    .where(eq(pipelineRuns.id, runId))
    .limit(1);
  if (!run) return false;
  const meta = (run.metadata ?? {}) as Record<string, unknown>;
  return (
    run.projectId === projectId &&
    run.kind === 'system' &&
    meta.source === 'release-batch' &&
    (run.status === 'running' || run.status === 'paused')
  );
}

export interface ActiveReleaseBatchInfo {
  runId: string;
  issueIds: string[];
  startedAt: string;
}

export async function getActiveReleaseBatch(
  projectId: string,
): Promise<ActiveReleaseBatchInfo | null> {
  const [run] = await db.execute<{ id: string; metadata: unknown; started_at: Date }>(sql`
    SELECT r.id, r.metadata, r.started_at
    FROM pipeline_runs r
    WHERE r.project_id = ${projectId}
      AND r.kind = 'system'
      AND r.status IN ('running', 'paused')
      AND (r.metadata->>'source') = 'release-batch'
    ORDER BY r.started_at DESC
    LIMIT 1
  `);
  if (!run) return null;

  const claimedIssues = await db
    .select({ id: issues.id })
    .from(issues)
    .where(eq(issues.releaseBatchRunId, run.id));

  return {
    runId: run.id,
    issueIds: claimedIssues.map((r) => r.id),
    startedAt:
      run.started_at instanceof Date ? run.started_at.toISOString() : String(run.started_at),
  };
}
