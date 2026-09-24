/**
 * ISS-103 — read-side rollup helpers for pipeline_runs.
 *
 * `pipeline_runs` stores only `currentStep` as a single text column; the full
 * step timeline + cost rollup are computed on the fly by joining
 * `agent_sessions` (steps) and `usage_records → jobs` (cost) on the run id.
 *
 * The web panel + project pipeline runs route consume the shapes exported
 * here so the front-end stays a thin renderer.
 */

import { asc, eq, inArray, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import {
  agentSessions,
  devices,
  issues,
  jobs,
  type PipelineRunKind,
  type PipelineRunStatus,
  pipelineRuns,
  projects,
  terminalAgentSessionStatuses,
  usageRecords,
} from '../db/schema.js';
import { type RunGate, readRunGate } from '../devices/gate-report.js';
import { RETRY_MAX_ROUNDS, readAutoRetryPayload } from '../jobs/retry.js';
import { UNHELD_LIVE_JOB_STATUSES } from '../jobs/status-sets.js';
import { formatIssueRef } from '../lib/issue-ref.js';
import { usageSessionMatch } from '../usage-records/rollup.js';

export type PipelineStepStatus = 'pending' | 'running' | 'completed' | 'failed' | 'skipped';

export interface PipelineRunStepSummary {
  jobType: string;
  status: PipelineStepStatus;
  startedAt: string | null;
  finishedAt: string | null;
  durationMs: number | null;
  agentSessionId: string | null;
}

export interface PipelineRunCostSummary {
  estimatedCost: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  requests: number;
  sampleCount: number;
}

/**
 * ISS-411 — one job row of a run's per-attempt timeline. Unlike `steps`
 * (one row per `jobType`, derived from `agent_sessions`), this is sourced from
 * the `jobs` table so the `retry_of` chain, the device each attempt landed on,
 * and the ISS-407 round-robin state (`payload._autoRetry`) are all visible.
 */
export interface PipelineRunAttempt {
  jobId: string;
  jobType: string;
  status: string;
  /** `jobs.attempts` — re-dispatch counter on this job row. */
  attempts: number;
  /** Prior job in the `retry_of` chain, if this row is a retry. */
  retryOf: string | null;
  deviceId: string | null;
  /** Friendly device name (`devices.name`), null when the device is gone. */
  deviceName: string | null;
  failureReason: string | null;
  /** ISS-877 cause token off the linked `agent_sessions` row; null when the
   *  attempt never reached a session, or died before one was classified. */
  failureCause: string | null;
  /** ISS-877 operator sentence that goes with the cause. */
  failureDetail: string | null;
  /** Retry-policy axis off the job row — a runner that went offline (`infra`)
   *  is not the same failure as a step that broke the build (`code`). */
  failureKind: 'code' | 'infra' | 'transient-cc' | 'timeout' | null;
  /** What the retry engine did with this failure. */
  failureAction: 'terminal' | 'quarantine' | 'failover' | 'retry' | null;
  queuedAt: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  /** ISS-407 round-robin rotation state at the time this row was (re)queued. */
  autoRetry: { round: number; target: string | null; tries: number; done: string[] } | null;
}

/**
 * ISS-411 — derived round-robin headline for the run, taken from the most
 * recent attempt's `_autoRetry`. `round N / maxRounds` + the device the next
 * attempt targets (resolved to a name) make "retried 3x on dev1, now round 2
 * targeting ubuntu5" legible at a glance.
 */
export interface PipelineRunRetrySummary {
  totalAttempts: number;
  round: number;
  maxRounds: number;
  targetDeviceId: string | null;
  targetDeviceName: string | null;
}

export interface PipelineRunSummary {
  id: string;
  projectId: string;
  issueId: string | null;
  /** ISS-460 — human ref (`ISS-<seq>`) of the run's issue; null for pm/system/interactive runs. */
  issueRef: string | null;
  /** ISS-460 — title of the run's issue; null when the run has no issue. */
  issueTitle: string | null;
  kind: PipelineRunKind;
  status: PipelineRunStatus;
  currentStep: string | null;
  startedAt: string;
  finishedAt: string | null;
  steps: PipelineRunStepSummary[];
  cost: PipelineRunCostSummary;
  /**
   * ISS-789 — jobs on this run that are not yet terminal (`queued`,
   * `dispatched`, `running`).
   */
  liveJobs: number;
  /**
   * ISS-998 — the newest heartbeat of any non-terminal `agent_sessions` row on
   * this run, or `null` where the run has none.
   */
  lastSessionBeatAt: string | null;
  /** ISS-411 — per-attempt device/retry timeline (jobs-sourced). */
  attempts: PipelineRunAttempt[];
  /** ISS-411 — round-robin headline; null when the run never retried. */
  retrySummary: PipelineRunRetrySummary | null;
  /** ISS-1192 — the box's declaration gate when this run opened; `null` where
   *  the box reported none. The list row omits it: it carries a breakdown. */
  gateAtOpen: RunGate | null;
}

export type PipelineRunListItem = Omit<
  PipelineRunSummary,
  'steps' | 'attempts' | 'retrySummary' | 'gateAtOpen'
>;

const EMPTY_COST: PipelineRunCostSummary = {
  estimatedCost: 0,
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheCreationTokens: 0,
  requests: 0,
  sampleCount: 0,
};

type RunRow = typeof pipelineRuns.$inferSelect;

function toIso(value: Date | string | null): string | null {
  if (value === null) return null;
  if (value instanceof Date) return value.toISOString();
  return value;
}

function toIsoRequired(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : value;
}

/**
 * Aggregate the agent_sessions for a single run into one step per `jobType`.
 * Status precedence: running > failed > completed > pending.
 */
async function loadStepsForRun(runId: string): Promise<PipelineRunStepSummary[]> {
  const rows = await db
    .select({
      jobType: sql<string>`coalesce(${agentSessions.metadata}->>'jobType', 'unknown')`,
      latestId: sql<string>`(array_agg(${agentSessions.id} ORDER BY ${agentSessions.updatedAt} DESC))[1]`,
      startedAt: sql<Date | null>`min(coalesce(${agentSessions.startedAt}, ${agentSessions.dispatchedAt}, ${agentSessions.createdAt}))`,
      finishedAt: sql<Date | null>`max(${agentSessions.updatedAt})`,
      hasRunning: sql<number>`bool_or(${agentSessions.status} = 'running')::int`,
      hasFailed: sql<number>`bool_or(${agentSessions.status} = 'failed')::int`,
      hasCompleted: sql<number>`bool_or(${agentSessions.status} = 'completed')::int`,
      hasOpen: sql<number>`bool_or(${agentSessions.status} in ('queued','idle'))::int`,
    })
    .from(agentSessions)
    .where(eq(agentSessions.pipelineRunId, runId))
    .groupBy(sql`coalesce(${agentSessions.metadata}->>'jobType', 'unknown')`);

  return rows.map((r) => {
    let status: PipelineStepStatus;
    if (Number(r.hasRunning) === 1) status = 'running';
    else if (Number(r.hasFailed) === 1) status = 'failed';
    else if (Number(r.hasCompleted) === 1) status = 'completed';
    else if (Number(r.hasOpen) === 1) status = 'pending';
    else status = 'pending';

    const startedAt = toIso(r.startedAt);
    const finishedAt = status === 'completed' || status === 'failed' ? toIso(r.finishedAt) : null;
    const durationMs =
      startedAt && finishedAt
        ? new Date(finishedAt).getTime() - new Date(startedAt).getTime()
        : null;

    return {
      jobType: r.jobType,
      status,
      startedAt,
      finishedAt,
      durationMs,
      agentSessionId: r.latestId ?? null,
    } satisfies PipelineRunStepSummary;
  });
}

async function loadCostForRun(runId: string): Promise<PipelineRunCostSummary> {
  const [row] = await db
    .select({
      estimatedCost: sql<number>`coalesce(sum(${usageRecords.estimatedCost}), 0)`.mapWith(Number),
      inputTokens: sql<number>`coalesce(sum(${usageRecords.inputTokens}), 0)`.mapWith(Number),
      outputTokens: sql<number>`coalesce(sum(${usageRecords.outputTokens}), 0)`.mapWith(Number),
      cacheReadTokens: sql<number>`coalesce(sum(${usageRecords.cacheReadTokens}), 0)`.mapWith(
        Number,
      ),
      cacheCreationTokens:
        sql<number>`coalesce(sum(${usageRecords.cacheCreationTokens}), 0)`.mapWith(Number),
      requests: sql<number>`coalesce(sum(${usageRecords.requestCount}), 0)`.mapWith(Number),
      sampleCount: sql<number>`count(${usageRecords.id})`.mapWith(Number),
    })
    .from(usageRecords)
    .innerJoin(agentSessions, usageSessionMatch(sql`= ${agentSessions.id}::text`))
    .where(eq(agentSessions.pipelineRunId, runId));

  return row ?? EMPTY_COST;
}

/**
 * ISS-411 — per-attempt timeline for one run, sourced from `jobs` (NOT
 * `agent_sessions`), ordered oldest-first. Left-joins `devices` so each
 * attempt carries the runner-friendly device name, and reads the ISS-407
 * `payload._autoRetry` rotation state defensively (absent on pre-407 rows →
 * null). Also returns a derived `retrySummary` headline from the latest row.
 */
async function loadAttemptsForRun(runId: string): Promise<{
  attempts: PipelineRunAttempt[];
  retrySummary: PipelineRunRetrySummary | null;
}> {
  const rows = await db
    .select({
      jobId: jobs.id,
      jobType: jobs.type,
      status: jobs.status,
      attempts: jobs.attempts,
      retryOf: jobs.retryOf,
      deviceId: jobs.deviceId,
      deviceName: devices.name,
      failureReason: jobs.failureReason,
      failureKind: jobs.failureKind,
      failureAction: jobs.failureAction,
      failureCause: agentSessions.failureReason,
      failureDetail: agentSessions.failureDetail,
      queuedAt: jobs.queuedAt,
      startedAt: jobs.dispatchedAt,
      finishedAt: jobs.finishedAt,
      payload: jobs.payload,
    })
    .from(jobs)
    .leftJoin(devices, eq(devices.id, jobs.deviceId))
    .leftJoin(agentSessions, eq(agentSessions.id, jobs.agentSessionId))
    .where(eq(jobs.pipelineRunId, runId))
    .orderBy(asc(jobs.queuedAt));

  const nameById = new Map<string, string>();
  for (const r of rows) {
    if (r.deviceId && r.deviceName) nameById.set(r.deviceId, r.deviceName);
  }

  const attempts: PipelineRunAttempt[] = rows.map((r) => {
    const hasAutoRetry =
      !!r.payload &&
      typeof r.payload === 'object' &&
      '_autoRetry' in (r.payload as Record<string, unknown>);
    const ar = hasAutoRetry ? readAutoRetryPayload(r.payload) : null;
    return {
      jobId: r.jobId,
      jobType: r.jobType,
      status: r.status,
      attempts: r.attempts ?? 0,
      retryOf: r.retryOf ?? null,
      deviceId: r.deviceId ?? null,
      deviceName: r.deviceName ?? null,
      failureReason: r.failureReason ?? null,
      failureCause: r.failureCause ?? null,
      failureDetail: r.failureDetail ?? null,
      failureKind: r.failureKind ?? null,
      failureAction: r.failureAction ?? null,
      queuedAt: toIso(r.queuedAt),
      startedAt: toIso(r.startedAt),
      finishedAt: toIso(r.finishedAt),
      autoRetry: ar,
    } satisfies PipelineRunAttempt;
  });

  let retrySummary: PipelineRunRetrySummary | null = null;
  for (let i = attempts.length - 1; i >= 0; i--) {
    const ar = attempts[i]?.autoRetry;
    if (ar) {
      retrySummary = {
        totalAttempts: attempts.length,
        round: ar.round,
        maxRounds: RETRY_MAX_ROUNDS,
        targetDeviceId: ar.target,
        targetDeviceName: ar.target ? (nameById.get(ar.target) ?? null) : null,
      };
      break;
    }
  }

  return { attempts, retrySummary };
}

function rowToListItem(row: RunRow): PipelineRunListItem {
  return {
    id: row.id,
    projectId: row.projectId,
    issueId: row.issueId,
    // ISS-460 — resolved by callers that join `issues`; default null here.
    issueRef: null,
    issueTitle: null,
    kind: row.kind,
    status: row.status,
    currentStep: row.currentStep,
    startedAt: toIsoRequired(row.startedAt),
    finishedAt: toIso(row.finishedAt),
    cost: EMPTY_COST,
    liveJobs: 0,
    lastSessionBeatAt: null,
  };
}

/** ISS-460 — batch-resolve `{ issueRef, issueTitle }` for the given issue ids. */
async function loadIssueRefs(
  issueIds: string[],
): Promise<Map<string, { issueRef: string | null; issueTitle: string | null }>> {
  const out = new Map<string, { issueRef: string | null; issueTitle: string | null }>();
  if (issueIds.length === 0) return out;
  const rows = await db
    .select({
      id: issues.id,
      issSeq: issues.issSeq,
      issuePrefix: projects.issuePrefix,
      title: issues.title,
    })
    .from(issues)
    .innerJoin(projects, eq(projects.id, issues.projectId))
    .where(inArray(issues.id, issueIds));
  for (const r of rows) {
    out.set(r.id, {
      issueRef: r.issSeq != null ? formatIssueRef(r.issuePrefix, r.issSeq) : null,
      issueTitle: r.title ?? null,
    });
  }
  return out;
}

/** Load a single run with steps + cost rolled up. Returns null if missing. */
export async function loadPipelineRunSummary(runId: string): Promise<PipelineRunSummary | null> {
  const [row] = await db.select().from(pipelineRuns).where(eq(pipelineRuns.id, runId)).limit(1);
  if (!row) return null;

  const [steps, cost, attemptRollup, issueRefs, liveMap] = await Promise.all([
    loadStepsForRun(runId),
    loadCostForRun(runId),
    loadAttemptsForRun(runId),
    loadIssueRefs(row.issueId ? [row.issueId] : []),
    loadRunLivenessByRunIds([runId]),
  ]);

  const ref = row.issueId ? issueRefs.get(row.issueId) : undefined;
  return {
    ...rowToListItem(row),
    issueRef: ref?.issueRef ?? null,
    issueTitle: ref?.issueTitle ?? null,
    liveJobs: liveMap.get(runId)?.liveJobs ?? 0,
    lastSessionBeatAt: liveMap.get(runId)?.beat ?? null,
    steps,
    cost,
    attempts: attemptRollup.attempts,
    retrySummary: attemptRollup.retrySummary,
    gateAtOpen: readRunGate(row.metadata, runId),
  };
}

const sqlList = (values: readonly string[]) =>
  sql.join(
    values.map((v) => sql`${v}`),
    sql`, `,
  );

/**
 * Both halves of run liveness for many runs, in ONE statement. `live_jobs`
 * counts work the pipeline is moving, so it asks
 * {@link UNHELD_LIVE_JOB_STATUSES} rather than `jobs/status-sets.ts`'s
 * `LIVE_JOB_STATUSES`: a run whose only job is parked on a person is not work
 * in flight, and counting it would keep that run out of the stalled band for
 * as long as it waits.
 */
async function loadRunLivenessByRunIds(
  runIds: string[],
): Promise<Map<string, { liveJobs: number; beat: string | null }>> {
  const out = new Map<string, { liveJobs: number; beat: string | null }>();
  if (runIds.length === 0) return out;
  const rows = await db.execute<{
    run_id: string;
    live_jobs: number | string;
    last_beat: Date | string | null;
  }>(sql`
    SELECT
      r.id AS run_id,
      (SELECT count(*) FROM ${jobs} j
        WHERE j.pipeline_run_id = r.id
          AND j.status IN (${sqlList(UNHELD_LIVE_JOB_STATUSES)})) AS live_jobs,
      (SELECT max(s.last_heartbeat_at) FROM ${agentSessions} s
        WHERE s.pipeline_run_id = r.id
          AND s.status NOT IN (${sqlList(terminalAgentSessionStatuses)})) AS last_beat
    FROM ${pipelineRuns} r
    WHERE r.id IN (${sqlList(runIds)})
  `);
  for (const r of rows) {
    if (!r.run_id) continue;
    out.set(r.run_id, { liveJobs: Number(r.live_jobs), beat: toIso(r.last_beat) });
  }
  return out;
}

/**
 * Cost rollup for many runs in one round-trip. Returns a map keyed by run id.
 * Runs with no usage rows are absent from the map; callers should fall back
 * to {@link EMPTY_COST}.
 */
async function loadCostByRunIds(runIds: string[]): Promise<Map<string, PipelineRunCostSummary>> {
  const out = new Map<string, PipelineRunCostSummary>();
  if (runIds.length === 0) return out;
  const rows = await db
    .select({
      runId: agentSessions.pipelineRunId,
      estimatedCost: sql<number>`coalesce(sum(${usageRecords.estimatedCost}), 0)`.mapWith(Number),
      inputTokens: sql<number>`coalesce(sum(${usageRecords.inputTokens}), 0)`.mapWith(Number),
      outputTokens: sql<number>`coalesce(sum(${usageRecords.outputTokens}), 0)`.mapWith(Number),
      cacheReadTokens: sql<number>`coalesce(sum(${usageRecords.cacheReadTokens}), 0)`.mapWith(
        Number,
      ),
      cacheCreationTokens:
        sql<number>`coalesce(sum(${usageRecords.cacheCreationTokens}), 0)`.mapWith(Number),
      requests: sql<number>`coalesce(sum(${usageRecords.requestCount}), 0)`.mapWith(Number),
      sampleCount: sql<number>`count(${usageRecords.id})`.mapWith(Number),
    })
    // ISS-460 — join through agent_sessions (usage_records.session_id is an
    // agent_sessions.id, not a job id; verified beta ISS-308). ISS-1015: the
    // cast belongs on the uuid side so the text index serves the join.
    .from(usageRecords)
    .innerJoin(agentSessions, usageSessionMatch(sql`= ${agentSessions.id}::text`))
    .where(inArray(agentSessions.pipelineRunId, runIds))
    .groupBy(agentSessions.pipelineRunId);
  for (const r of rows) {
    if (!r.runId) continue;
    out.set(r.runId, {
      estimatedCost: r.estimatedCost,
      inputTokens: r.inputTokens,
      outputTokens: r.outputTokens,
      cacheReadTokens: r.cacheReadTokens,
      cacheCreationTokens: r.cacheCreationTokens,
      requests: r.requests,
      sampleCount: r.sampleCount,
    });
  }
  return out;
}

/** Bulk list-item rollup. Preserves the input order. */
export async function listItemsFromRows(rows: RunRow[]): Promise<PipelineRunListItem[]> {
  if (rows.length === 0) return [];
  const ids = rows.map((r) => r.id);
  const issueIds = [...new Set(rows.map((r) => r.issueId).filter((v): v is string => v != null))];
  const [costMap, issueRefs, liveMap] = await Promise.all([
    loadCostByRunIds(ids),
    loadIssueRefs(issueIds),
    loadRunLivenessByRunIds(ids),
  ]);
  return rows.map((r) => {
    const ref = r.issueId ? issueRefs.get(r.issueId) : undefined;
    return {
      ...rowToListItem(r),
      issueRef: ref?.issueRef ?? null,
      issueTitle: ref?.issueTitle ?? null,
      cost: costMap.get(r.id) ?? EMPTY_COST,
      liveJobs: liveMap.get(r.id)?.liveJobs ?? 0,
      lastSessionBeatAt: liveMap.get(r.id)?.beat ?? null,
    };
  });
}

export { EMPTY_COST as PIPELINE_RUN_EMPTY_COST };
