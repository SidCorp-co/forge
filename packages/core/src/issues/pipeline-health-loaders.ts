/**
 * ISS-164 — the SQL loaders behind `pipeline-health.ts`.
 *
 * Split out at the seam that file's header already names: the loader half is
 * plain batched reads whose only contract is with the dispatch picker's own
 * queries, while the classifier half owns precedence between gate arms. Each
 * function here mirrors ONE of the picker's CTEs, and the guard beside it names
 * the incident that mirror came from.
 */

import { and, eq, inArray } from 'drizzle-orm';
import { db } from '../db/client.js';
import { jobs, pipelineRuns } from '../db/schema.js';
import { extractStageStatus } from '../jobs/stage-overrides.js';
import type { PipelineHealthJob } from './pipeline-health-types.js';

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
