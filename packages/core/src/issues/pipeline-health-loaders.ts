/**
 * ISS-164 — the SQL loaders behind `pipeline-health.ts`.
 *
 * Split out at the seam that file's header already names: the loader half is
 * plain batched reads whose only contract is with the dispatch picker's own
 * queries, while the classifier half owns precedence between gate arms. Each
 * function here mirrors ONE of the picker's CTEs, and the guard beside it names
 * the incident that mirror came from.
 */

import { and, eq, inArray, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { jobs, pipelineRuns, runners } from '../db/schema.js';
import { extractStageStatus } from '../jobs/stage-overrides.js';
import type { PipelineHealthJob, PipelineHealthRunnerSat } from './pipeline-health-types.js';

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

// cm:edge lockstep -> packages/core/src/runners/device-cap.ts#effectiveDeviceCap — the health view's idea of capacity has to be the dispatcher's, or the UI reports headroom the gate will not grant. Both are per DEVICE now, so two bindings of one box share one number rather than each claiming it.
function runnerDefaultConcurrency(_runnerType: string): number {
  return 1;
}

/**
 * Q6 — in-flight load on the runners that queued candidates are pinned to.
 * Empty when no candidate has a `runner_id` (nothing to be saturated).
 */
// cm:guard count only `dispatched|running` here — this mirrors the gate's `runner_load` CTE, where `held` is deliberately absent because a held job has released its slot; adding it reports `runner_full` for a runner that is in fact free
export async function loadPinnedRunnerSaturation(
  jobsByIssue: ReadonlyMap<string, PipelineHealthJob[]>,
): Promise<Map<string, PipelineHealthRunnerSat>> {
  const candidateRunnerIds = new Set<string>();
  for (const list of jobsByIssue.values()) {
    for (const j of list) {
      if (j.status === 'queued' && j.runnerId) candidateRunnerIds.add(j.runnerId);
    }
  }
  const out = new Map<string, PipelineHealthRunnerSat>();
  if (candidateRunnerIds.size === 0) return out;

  const ids = [...candidateRunnerIds];
  const runnerRows = await db
    .select({ id: runners.id, type: runners.type, capabilities: runners.capabilities })
    .from(runners)
    .where(inArray(runners.id, ids));
  const inFlightRows = await db
    .select({ runnerId: jobs.runnerId, count: sql<string>`COUNT(*)::text` })
    .from(jobs)
    .where(and(inArray(jobs.runnerId, ids), inArray(jobs.status, ['dispatched', 'running'])))
    .groupBy(jobs.runnerId);

  const inFlightByRunner = new Map<string, number>();
  for (const r of inFlightRows) {
    if (r.runnerId) inFlightByRunner.set(r.runnerId, Number(r.count));
  }
  for (const r of runnerRows) {
    const caps = (r.capabilities ?? {}) as Record<string, unknown>;
    const cap =
      typeof caps.maxConcurrent === 'number' && caps.maxConcurrent > 0
        ? caps.maxConcurrent
        : runnerDefaultConcurrency(r.type);
    out.set(r.id, { type: r.type, cap, inFlight: inFlightByRunner.get(r.id) ?? 0 });
  }
  return out;
}
