// Read-only views over a batch release: what is waiting, what is running.
//
// Split out of `service.ts` because these answer questions and change nothing,
// while everything left there claims or releases a claim. The file was also
// past the 500-line budget, and the queries were the half with no invariants
// attached to them.

import { and, eq, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { type IssueStatus, issues, pipelineRuns, schedules } from '../db/schema.js';
import { readProjectBranches } from '../projects/service.js';
import { nextRunFor } from '../schedules/cron.js';
import { resolveReleaseChannel } from './channel.js';
import { resolveReleaseGate } from './gate.js';

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
  channel: string | null;
  releaseRunnerLabel: string | null;
  /** The branch these issues merged into — what "merged" means to a reader. */
  baseBranch: string | null;
  /** When the next scheduled cut fires. `null` = nobody scheduled one. */
  nextCutAt: string | null;
  issues: ReleaseRosterEntry[];
}

/**
 * The soonest enabled `release_batch` schedule for this project. Null means
 * nobody scheduled a cut, which the UI must say in those words.
 */
// cm:guard NEVER fall back to "some default cadence" here. A countdown to a cut nothing will perform is worse than no countdown: it tells a person their issue ships tonight, and it does not.
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
  const channel = await resolveReleaseChannel(projectId);
  if (!gateStatus) {
    return {
      gateStatus: null,
      channel: channel.provider,
      releaseRunnerLabel: channel.releaseRunnerLabel,
      baseBranch: null,
      nextCutAt: null,
      issues: [],
    };
  }
  const nextCutAt = await nextScheduledCutAt(projectId);
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
    // cm:guard NULLS LAST, not NULLS FIRST: a row with no merge stamp predates the gate, and floating it to the top would present the least-known issue as the most overdue
    .orderBy(sql`${issues.mergedAt} ASC NULLS LAST`);

  const now = Date.now();
  return {
    gateStatus,
    channel: channel.provider,
    releaseRunnerLabel: channel.releaseRunnerLabel,
    baseBranch: branches?.baseBranch ?? null,
    nextCutAt,
    issues: rows.map((r) => ({
      id: r.id,
      displayId: r.issSeq != null ? `ISS-${r.issSeq}` : r.id,
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
