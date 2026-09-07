/**
 * ISS-164 — the SQL loaders behind `pipeline-health.ts`.
 *
 * Split out at the seam that file's header already names: the loader half is
 * plain batched reads whose only contract is with the dispatch picker's own
 * queries, while the classifier half owns precedence between gate arms. Each
 * function here mirrors ONE of the picker's CTEs, and the guard beside it names
 * the incident that mirror came from.
 */

import { and, desc, eq, inArray } from 'drizzle-orm';
import { db } from '../db/client.js';
import { jobs, pipelineRuns } from '../db/schema.js';
import { extractStageStatus } from '../jobs/stage-overrides.js';
import { describePause } from '../pipeline/run-pause.js';
import type { PipelineHealthJob, PipelineHealthPausedRun } from './pipeline-health-types.js';

/**
 * Q3 — the issue's live jobs, bucketed by issue id.
 */
// cm:guard `held` MUST be loaded here but MUST NOT be counted at the runner-in-flight query in the loader below — this feeds the `issue_busy` and `job_held` reasons, which mirror L1 `issueBusyJob` (held blocks a duplicate), while that query mirrors `runner_load` (held burns no cap). Drop it here and the gate refuses to dispatch while pipelineHealth reports no waitingOn at all — the exact lie this file's lockstep edge exists to prevent.
export async function loadActiveJobsByIssue(
  projectId: string,
  ids: string[],
): Promise<Map<string, PipelineHealthJob[]>> {
  const rows = await db
    .select({
      id: jobs.id,
      type: jobs.type,
      status: jobs.status,
      queuedAt: jobs.queuedAt,
      runnerId: jobs.runnerId,
      agentSessionId: jobs.agentSessionId,
      issueId: jobs.issueId,
      failureReason: jobs.failureReason,
      pipelineRunStatus: pipelineRuns.status,
      payload: jobs.payload,
      retryAfterAt: jobs.retryAfterAt,
    })
    .from(jobs)
    .leftJoin(pipelineRuns, eq(pipelineRuns.id, jobs.pipelineRunId))
    .where(
      and(
        eq(jobs.projectId, projectId),
        inArray(jobs.issueId, ids),
        inArray(jobs.status, ['queued', 'dispatched', 'running', 'held']),
      ),
    );
  const byIssue = new Map<string, PipelineHealthJob[]>();
  for (const r of rows) {
    if (!r.issueId) continue;
    const bucket = byIssue.get(r.issueId) ?? [];
    bucket.push({
      id: r.id,
      type: r.type,
      status: r.status,
      queuedAt: r.queuedAt,
      runnerId: r.runnerId,
      agentSessionId: r.agentSessionId,
      failureReason: r.failureReason,
      pipelineRunStatus: r.pipelineRunStatus,
      stageStatus: extractStageStatus(r.payload),
      retryAfterAt: r.retryAfterAt,
    });
    byIssue.set(r.issueId, bucket);
  }
  return byIssue;
}

/**
 * Q4 — the issue's paused pipeline run, one per issue, newest first.
 *
 * Deliberately NOT a join off `jobs` like Q3 above: the whole point of ISS-853
 * is the case where the run has no queued job to be joined from, so this reads
 * `pipeline_runs` by issue id directly.
 */
// cm:guard filter on `status = 'paused'` and nothing else — narrowing this by the issue's own status, or by whether the run has queued work, rebuilds exactly the blind spot ISS-853 closed: a run paused with nothing queued under an issue that still reads `approved`
export async function loadPausedRunsByIssue(
  projectId: string,
  ids: string[],
): Promise<Map<string, PipelineHealthPausedRun>> {
  const rows = await db
    .select({
      id: pipelineRuns.id,
      issueId: pipelineRuns.issueId,
      metadata: pipelineRuns.metadata,
      updatedAt: pipelineRuns.updatedAt,
    })
    .from(pipelineRuns)
    .where(
      and(
        eq(pipelineRuns.projectId, projectId),
        eq(pipelineRuns.status, 'paused'),
        inArray(pipelineRuns.issueId, ids),
      ),
    )
    .orderBy(desc(pipelineRuns.updatedAt));

  const byIssue = new Map<string, PipelineHealthPausedRun>();
  for (const r of rows) {
    if (!r.issueId || byIssue.has(r.issueId)) continue;
    const raw = (r.metadata as Record<string, unknown> | null)?.pauseReason;
    const pauseReason = typeof raw === 'string' && raw !== '' ? raw : null;
    const { kind, detail, resumer } = describePause(pauseReason);
    byIssue.set(r.issueId, {
      runId: r.id,
      pauseReason,
      kind,
      detail,
      resumer,
      since: (r.updatedAt ?? new Date()).toISOString(),
    });
  }
  return byIssue;
}
