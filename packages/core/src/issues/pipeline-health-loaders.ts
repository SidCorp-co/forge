/**
 * ISS-164 — the SQL loaders behind `pipeline-health.ts`.
 *
 * Split out at the seam that file's header already names: the loader half is
 * plain batched reads whose only contract is with the dispatch picker's own
 * queries, while the classifier half owns precedence between gate arms. Each
 * function here mirrors ONE of the picker's CTEs, and the guard beside it names
 * the incident that mirror came from.
 */

import { and, desc, eq, inArray, type SQL, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { jobs, pipelineRuns } from '../db/schema.js';
import {
  RUN_GROUP_METADATA_KEY,
  RUN_ISSUE_STATUSES_METADATA_KEY,
} from '../devices/run-session-keys.js';
import { extractStageStatus } from '../jobs/stage-overrides.js';
import { LIVE_JOB_STATUSES } from '../jobs/status-sets.js';
import { describePause } from '../pipeline/run-pause.js';
import type { SessionWorkerLane } from './issue-worker.js';
import type {
  PipelineHealthJob,
  PipelineHealthPausedRun,
  PipelineHealthSession,
} from './pipeline-health-types.js';

/**
 * Q3 — the issue's live jobs, bucketed by issue id.
 */
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
        inArray(jobs.status, [...LIVE_JOB_STATUSES]),
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

type SessionRow = {
  id: string;
  status: string;
  metadata: Record<string, unknown> | null;
  issue_id: string;
  lane: SessionWorkerLane;
  holds: boolean;
};

/**
 * Q2 — every session opened over each issue, bucketed by issue id, newest first, and whether it
 * holds the issue now (ISS-1320).
 *
 * The job lane's `metadata.issueId` is one session, one issue, held for as long as the session
 * lives. A run session carries a GROUP, and two records link it to an issue: `issue_leases`, the
 * run's HOLD, which goes once the run gives the issue back, and the run's recorded group
 * (`runGroup`, else the keys `runIssueStatuses` was stamped with), which nothing rewrites. The
 * hold decides who is working the issue and the group decides how many sessions were opened over
 * it, so a finished run still counts and a live run that moved on is not mistaken for a worker.
 * No status filter: the sentence that counts them lists the statuses it saw.
 */
export async function loadSessionsByIssue(
  projectId: string,
  idList: SQL,
): Promise<Map<string, PipelineHealthSession[]>> {
  const groupKeys = (key: string, shape: 'array' | 'object') =>
    shape === 'array'
      ? sql`jsonb_array_elements_text(CASE WHEN jsonb_typeof(r.metadata -> ${key}::text) = 'array'
              THEN r.metadata -> ${key}::text ELSE '[]'::jsonb END)`
      : sql`jsonb_object_keys(CASE WHEN jsonb_typeof(r.metadata -> ${key}::text) = 'object'
              THEN r.metadata -> ${key}::text ELSE '{}'::jsonb END)`;
  const rows = (await db.execute(sql`
    SELECT s.id, s.status, s.metadata, i.id AS issue_id, 'job' AS lane, true AS holds, s.updated_at
      FROM agent_sessions s
      JOIN issues i ON i.id::text = s.metadata->>'issueId'
     WHERE s.project_id = ${projectId}
       AND i.id IN ${idList}
    UNION ALL
    SELECT s.id, s.status, s.metadata, b.issue_id, 'run_session' AS lane,
           bool_or(b.holds) AS holds, s.updated_at
      FROM (
        SELECT l.session_id, i.id AS issue_id, true AS holds
          FROM issue_leases l
          JOIN issues i ON i.project_id = l.project_id
                       AND 'ISS-' || i.iss_seq = l.issue_key -- ISS-992:canonical
         WHERE l.project_id = ${projectId}
           AND i.id IN ${idList}
        UNION ALL
        SELECT s.id, i.id, false
          FROM agent_sessions s
          JOIN pipeline_runs r ON r.id = s.pipeline_run_id
          CROSS JOIN LATERAL ${groupKeys(RUN_GROUP_METADATA_KEY, 'array')} AS k(key)
          JOIN issues i ON i.project_id = s.project_id AND 'ISS-' || i.iss_seq = k.key -- ISS-992:canonical
         WHERE s.project_id = ${projectId}
           AND s.kind = 'run_session'
           AND i.id IN ${idList}
        UNION ALL
        SELECT s.id, i.id, false
          FROM agent_sessions s
          JOIN pipeline_runs r ON r.id = s.pipeline_run_id
          CROSS JOIN LATERAL ${groupKeys(RUN_ISSUE_STATUSES_METADATA_KEY, 'object')} AS k(key)
          JOIN issues i ON i.project_id = s.project_id AND 'ISS-' || i.iss_seq = k.key -- ISS-992:canonical
         WHERE s.project_id = ${projectId}
           AND s.kind = 'run_session'
           AND i.id IN ${idList}
      ) b
      JOIN agent_sessions s ON s.id = b.session_id
     WHERE s.project_id = ${projectId}
     GROUP BY s.id, b.issue_id
     ORDER BY updated_at DESC
  `)) as unknown as Array<SessionRow>;
  const byIssue = new Map<string, PipelineHealthSession[]>();
  for (const r of rows) {
    const bucket = byIssue.get(r.issue_id) ?? [];
    bucket.push({
      id: r.id,
      status: r.status,
      metadata: r.metadata ?? null,
      lane: r.lane,
      holds: r.holds,
    });
    byIssue.set(r.issue_id, bucket);
  }
  return byIssue;
}
