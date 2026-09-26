// Read-only views over a batch release: what is waiting, what is running.
//
// Split out of `service.ts` because these answer questions and change nothing,
// while everything left there claims or releases a claim. The file was also
// past the 500-line budget, and the queries were the half with no invariants
// attached to them.
//
// `loadReleaseBatchContext` joined them from the same file for the same reason
// (ISS-1042): it is the batch reconstructed from its run's metadata and its
// claimed rows, it writes nothing, and `service.ts` went back over budget as
// the ledger, the method gate and the promotion-aware abort landed.

import { and, eq, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { type IssueStatus, issues, jobs, pipelineRuns, schedules } from '../db/schema.js';
import { activeIssuePrefix } from '../issues/issue-prefix-read.js';
import { formatIssueRef } from '../lib/issue-ref.js';
import { readProjectBranches } from '../projects/service.js';
import { nextRunFor } from '../schedules/cron.js';
import { releaseRunnerLabelOf, resolveReleaseChannels } from './channel.js';
import { RELEASE_GATE_STATUS, resolveReleaseGate } from './gate.js';
import { releaseBranches } from './plan.js';
import { currentReleaseVersion } from './version-store.js';

export interface ReleaseRosterEntry {
  id: string;
  displayId: string;
  title: string;
  /** When the branch landed on the base branch. Null only for legacy rows. */
  mergedAt: string | null;
  /** Whole days since the merge, so "oldest 6 days" is a read, not a sum. */
  waitingDays: number | null;
  claimedByRunId: string | null;
}

export interface ReleaseRoster {
  /** `null` when the project has no gate — the UI hides the whole surface. */
  gateStatus: IssueStatus | null;
  /** Every live deploy binding's provider. Core hands the SET to the release agent. */
  channels: string[];
  releaseRunnerLabel: string | null;
  /** The branch these issues merged into — what "merged" means to a reader. */
  baseBranch: string | null;
  /** When the next scheduled cut fires. `null` = nobody scheduled one. */
  nextCutAt: string | null;
  /**
   * The version the project is serving: what the last release to SHIP cut. `null` when no release
   * here has ever shipped. Read off the ship stamp rather than the run's status, because
   * `cancelConcludedRun` flips a `completed` run to `cancelled` without taking the bytes down.
   */
  currentVersion: string | null;
  issues: ReleaseRosterEntry[];
}

/**
 * The soonest enabled `release_batch` schedule for this project. Null means
 * nobody scheduled a cut, which the UI must say in those words.
 */
async function nextScheduledCutAt(projectId: string): Promise<string | null> {
  const rows = await db
    .select({ cron: schedules.cron })
    .from(schedules)
    .where(
      and(
        eq(schedules.projectId, projectId),
        eq(schedules.kind, 'release_batch'),
        eq(schedules.enabled, true),
      ),
    );
  const times = rows
    .map((r) => nextRunFor(r.cron))
    .filter((d): d is Date => d != null)
    .sort((a, b) => a.getTime() - b.getTime());
  return times[0]?.toISOString() ?? null;
}

/**
 * Everything waiting for a release, oldest merge first. The point of the
 * ordering is that "12 waiting, oldest 6 days" becomes a query rather than
 * something a person reconstructs from a notification they may not have read.
 */
export async function loadReleaseRoster(projectId: string): Promise<ReleaseRoster> {
  const gateStatus = await resolveReleaseGate(projectId);
  const channels = await resolveReleaseChannels(projectId);
  if (!gateStatus) {
    return {
      gateStatus: null,
      channels: [],
      releaseRunnerLabel: null,
      baseBranch: null,
      nextCutAt: null,
      currentVersion: null,
      issues: [],
    };
  }
  const nextCutAt = await nextScheduledCutAt(projectId);
  const currentVersion = await currentReleaseVersion(projectId);
  const branches = await readProjectBranches(projectId);

  const rows = await db
    .select({
      id: issues.id,
      issSeq: issues.issSeq,
      title: issues.title,
      mergedAt: issues.mergedAt,
      releaseBatchRunId: issues.releaseBatchRunId,
    })
    .from(issues)
    .where(and(eq(issues.projectId, projectId), eq(issues.status, gateStatus)))
    .orderBy(sql`${issues.mergedAt} ASC NULLS LAST`);

  const now = Date.now();
  const prefix = await activeIssuePrefix(projectId);
  return {
    gateStatus,
    channels: channels.map((c) => c.provider),
    releaseRunnerLabel: releaseRunnerLabelOf(projectId, channels),
    baseBranch: branches?.baseBranch ?? null,
    nextCutAt,
    currentVersion,
    issues: rows.map((r) => ({
      id: r.id,
      displayId: r.issSeq != null ? formatIssueRef(prefix, r.issSeq) : r.id,
      title: r.title ?? '(untitled)',
      mergedAt: r.mergedAt ? r.mergedAt.toISOString() : null,
      waitingDays: r.mergedAt
        ? Math.floor((now - r.mergedAt.getTime()) / (24 * 60 * 60 * 1000))
        : null,
      claimedByRunId: r.releaseBatchRunId,
    })),
  };
}

export async function findReleaseBatchRun(
  runId: string,
): Promise<{ id: string; projectId: string } | null> {
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
  return meta.source === 'release-batch' ? { id: run.id, projectId: run.projectId } : null;
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
  /** The version this release cut. `null` only on a release row nothing versioned. */
  version: string | null;
}

export async function getActiveReleaseBatch(
  projectId: string,
): Promise<ActiveReleaseBatchInfo | null> {
  const [run] = await db.execute<{
    id: string;
    metadata: unknown;
    started_at: Date;
    release_version: string | null;
  }>(sql`
    SELECT r.id, r.metadata, r.started_at, r.release_version
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
    version: run.release_version,
  };
}

export interface ReleaseBatchIssue {
  id: string;
  displayId: string;
  title: string;
  releaseNotes: unknown;
  status: IssueStatus;
}

/**
 * Which box this release was meant for, whether it got one, and which box took
 * the job.
 *
 * `null` for a run opened before ISS-1128, which recorded no verdict: saying
 * `preferenceMet: false` there would claim a reading nobody took.
 */
export interface ReleaseRunnerAccount {
  /** The declared preference, as the live deploy bindings resolved it. */
  label: string | null;
  /** False where no box eligible to release carried the label. */
  preferenceMet: boolean;
  /** The box the release job was claimed on, or `null` while nobody has. */
  claimedByDeviceId: string | null;
}

export interface ReleaseBatchContext {
  runId: string;
  projectId: string;
  gateStatus: IssueStatus;
  /** The version this release cut, which the release agent writes into the tag it pushes. */
  version: string | null;
  /** `null` where the project declares none; the release reads its branches from its own method. */
  baseBranch: string | null;
  /** Where a `promote` release lands; equals `baseBranch` under every other model. */
  liveBranch: string | null;
  deployPlanned: boolean;
  promotePlanned: boolean;
  releaseRunner: ReleaseRunnerAccount | null;
  issues: ReleaseBatchIssue[];
}

/** The declared preference and its verdict, off the run's own metadata. */
async function releaseRunnerAccount(
  runId: string,
  meta: Record<string, unknown>,
): Promise<ReleaseRunnerAccount | null> {
  const recorded = meta.releaseRunner;
  if (typeof recorded !== 'object' || recorded === null) return null;
  const { label, preferenceMet } = recorded as { label?: unknown; preferenceMet?: unknown };
  const [job] = await db
    .select({ deviceId: jobs.deviceId })
    .from(jobs)
    .where(and(eq(jobs.pipelineRunId, runId), eq(jobs.type, 'release_batch')))
    .orderBy(sql`${jobs.queuedAt} DESC`)
    .limit(1);
  return {
    label: typeof label === 'string' && label.length > 0 ? label : null,
    preferenceMet: preferenceMet === true,
    claimedByDeviceId: job?.deviceId ?? null,
  };
}

export async function loadReleaseBatchContext(runId: string): Promise<ReleaseBatchContext | null> {
  const [run] = await db
    .select({
      id: pipelineRuns.id,
      projectId: pipelineRuns.projectId,
      metadata: pipelineRuns.metadata,
      releaseVersion: pipelineRuns.releaseVersion,
    })
    .from(pipelineRuns)
    .where(eq(pipelineRuns.id, runId))
    .limit(1);

  if (!run) return null;
  const meta = (run.metadata ?? {}) as Record<string, unknown>;
  if (meta.source !== 'release-batch') return null;

  const gateStatus = (meta.gateStatus as IssueStatus | undefined) ?? RELEASE_GATE_STATUS;
  const deployPlanned = (meta.deployPlanned as boolean | undefined) ?? false;
  const promotePlanned = (meta.promotePlanned as boolean | undefined) ?? false;

  const project = (await readProjectBranches(run.projectId)) ?? {
    baseBranch: null,
    liveBranch: null,
    releaseModel: 'none' as const,
    releaseStrategy: null,
  };
  const { baseBranch, liveBranch } = releaseBranches(project, project.releaseModel);

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

  const claimedPrefix = await activeIssuePrefix(run.projectId);
  return {
    runId,
    projectId: run.projectId,
    gateStatus,
    version: run.releaseVersion,
    baseBranch,
    liveBranch,
    deployPlanned,
    promotePlanned,
    releaseRunner: await releaseRunnerAccount(runId, meta),
    issues: claimedIssues.map((r) => ({
      id: r.id,
      displayId: r.issSeq != null ? formatIssueRef(claimedPrefix, r.issSeq) : r.id,
      title: r.title ?? '(untitled)',
      releaseNotes: r.releaseNotes,
      status: r.status,
    })),
  };
}
