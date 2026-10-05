/**
 * ISS-103 — read-side rollup helpers for pipeline_runs.
 *
 * `pipeline_runs` stores only `currentStep` as a single text column; the full
 * step timeline + cost rollup are computed on the fly by joining
 * `agent_sessions` (steps) and agent-sessions' usage totals (cost) on the run id.
 *
 * The web panel + project pipeline runs route consume the shapes exported
 * here so the front-end stays a thin renderer.
 */

import { readAutoRetryPayload } from '@forge/contracts/jobs';
import { asc, eq, inArray, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import {
  agentSessions,
  devices,
  type IssueStatus,
  issues,
  jobs,
  pipelineRuns,
  projects,
} from '../db/schema.js';
import { formatIssueRef } from '../lib/issue-ref.js';
import {
  groupOf,
  laneOf,
  type PipelineRunGroup,
  type PipelineRunLane,
  type PipelineRunStep,
  type ResidentMaster,
  stepOf,
} from './runs-lane.js';
import { loadRunLivenessByRunIds, residentMasterOn } from './runs-liveness.js';

export type {
  PipelineRunGroup,
  PipelineRunLane,
  PipelineRunStep,
  ResidentMaster,
} from './runs-lane.js';

import { readRunGate, usageTotalsByRun, usageTotalsForRun } from './ports.js';
import type {
  PipelineRunAttempt,
  PipelineRunCostSummary,
  PipelineRunListItem,
  PipelineRunRetrySummary,
  PipelineRunStepSummary,
  PipelineRunSummary,
  PipelineStepStatus,
} from './runs-rollup-types.js';

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
 * Status precedence: running > failed > completed > cancelled > pending.
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
      hasCancelled: sql<number>`bool_or(${agentSessions.status} = 'cancelled')::int`,
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
    else if (Number(r.hasCancelled) === 1) status = 'cancelled';
    else if (Number(r.hasOpen) === 1) status = 'pending';
    else status = 'pending';

    const startedAt = toIso(r.startedAt);
    const finishedAt =
      status === 'completed' || status === 'failed' || status === 'cancelled'
        ? toIso(r.finishedAt)
        : null;
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

/**
 * ISS-411 — per-attempt timeline for one run, sourced from `jobs` (NOT
 * `agent_sessions`), ordered oldest-first. Left-joins `devices` so each
 * attempt carries the runner-friendly device name, and reads each row's
 * `payload._autoRetry` budget (absent on a first dispatch → null). Also returns
 * a derived `retrySummary` headline from the latest retry.
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

  const attempts: PipelineRunAttempt[] = rows.map((r) => {
    const held = readAutoRetryPayload(r.payload);
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
      maxAttempts: held?.maxAttempts ?? null,
    } satisfies PipelineRunAttempt;
  });

  let retrySummary: PipelineRunRetrySummary | null = null;
  for (let i = attempts.length - 1; i >= 0; i--) {
    const latest = attempts[i];
    if (latest?.maxAttempts) {
      retrySummary = {
        totalAttempts: attempts.length,
        attempt: latest.attempts,
        maxAttempts: latest.maxAttempts,
      };
      break;
    }
  }

  return { attempts, retrySummary };
}

function rowToListItem(row: RunRow): PipelineRunListItem {
  const lane = laneOf(row);
  const group = groupOf(row, lane);
  return {
    id: row.id,
    projectId: row.projectId,
    issueId: row.issueId,
    lane,
    ...withStep(lane, row.currentStep, undefined, group),
    ...withGroup(group),
    // ISS-460 — resolved by callers that join `issues`; default null here.
    issueRef: null,
    issueTitle: null,
    issueStatus: null,
    kind: row.kind,
    status: row.status,
    startedAt: toIsoRequired(row.startedAt),
    finishedAt: toIso(row.finishedAt),
    cost: EMPTY_COST,
    liveJobs: 0,
    lastSessionBeatAt: null,
    residentMaster: null,
  };
}

/** ISS-1273 — by construction, so a reader taking either gets the one answer `stepOf` reached. */
function withStep(
  lane: PipelineRunLane,
  currentStep: string | null,
  openPhase?: string,
  group?: PipelineRunGroup,
  master?: ResidentMaster | null,
): { step: PipelineRunStep; currentStep: string | null } {
  const step = stepOf(lane, currentStep, openPhase, group, master);
  return { step, currentStep: step.step };
}

function withGroup(group: PipelineRunGroup): { group: PipelineRunGroup; runIssues: string[] } {
  return { group, runIssues: group.issues };
}

/** ISS-1273 — a box-driven run's step is its open `phase_journal` row. Two open rows mean a
 *  driver never closed the earlier phase; the newest is the one it is on, the row
 *  `phase-journal.ts:resumePoint` resumes at, and `DISTINCT ON` settles that in the query rather
 *  than in whichever order rows arrived. */
async function loadOpenPhaseByRunIds(runIds: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (runIds.length === 0) return out;
  const rows = (await db.execute(sql`
    SELECT DISTINCT ON (run_id) run_id, phase
      FROM phase_journal
     WHERE ended_at IS NULL
       AND run_id IN (${sql.join(
         runIds.map((id) => sql`${id}::uuid`),
         sql`, `,
       )})
     ORDER BY run_id, started_at DESC, attempt DESC
  `)) as unknown as Array<{ run_id: string; phase: string }>;
  for (const r of rows) out.set(r.run_id, r.phase);
  return out;
}

type IssueRefView = {
  issueRef: string | null;
  issueTitle: string | null;
  issueStatus: IssueStatus;
};

/** Batch-resolve each issue's ref, title and status for the given issue ids. */
async function loadIssueRefs(issueIds: string[]): Promise<Map<string, IssueRefView>> {
  const out = new Map<string, IssueRefView>();
  if (issueIds.length === 0) return out;
  const rows = await db
    .select({
      id: issues.id,
      issSeq: issues.issSeq,
      issuePrefix: projects.issuePrefix,
      title: issues.title,
      status: issues.status,
    })
    .from(issues)
    .innerJoin(projects, eq(projects.id, issues.projectId))
    .where(inArray(issues.id, issueIds));
  for (const r of rows) {
    out.set(r.id, {
      issueRef: r.issSeq != null ? formatIssueRef(r.issuePrefix, r.issSeq) : null,
      issueTitle: r.title ?? null,
      issueStatus: r.status,
    });
  }
  return out;
}

/** Load a single run with steps + cost rolled up. Returns null if missing. */
export async function loadPipelineRunSummary(runId: string): Promise<PipelineRunSummary | null> {
  const [row] = await db.select().from(pipelineRuns).where(eq(pipelineRuns.id, runId)).limit(1);
  if (!row) return null;

  const listItem = rowToListItem(row);
  const [steps, cost, attemptRollup, issueRefs, liveMap, openPhase] = await Promise.all([
    loadStepsForRun(runId),
    usageTotalsForRun(runId),
    loadAttemptsForRun(runId),
    loadIssueRefs(row.issueId ? [row.issueId] : []),
    loadRunLivenessByRunIds([runId]),
    loadOpenPhaseByRunIds(listItem.lane === 'run_session' ? [runId] : []),
  ]);

  const ref = row.issueId ? issueRefs.get(row.issueId) : undefined;
  const residentMaster = residentMasterOn(listItem.lane, liveMap.get(runId));
  return {
    ...listItem,
    ...withStep(
      listItem.lane,
      row.currentStep,
      openPhase.get(runId),
      listItem.group,
      residentMaster,
    ),
    issueRef: ref?.issueRef ?? null,
    issueTitle: ref?.issueTitle ?? null,
    issueStatus: ref?.issueStatus ?? null,
    liveJobs: liveMap.get(runId)?.liveJobs ?? 0,
    lastSessionBeatAt: liveMap.get(runId)?.beat ?? null,
    residentMaster,
    steps,
    cost,
    attempts: attemptRollup.attempts,
    retrySummary: attemptRollup.retrySummary,
    gateAtOpen: readRunGate(row.metadata, runId),
  };
}

/** Bulk list-item rollup. Preserves the input order. */
export async function listItemsFromRows(rows: RunRow[]): Promise<PipelineRunListItem[]> {
  if (rows.length === 0) return [];
  const ids = rows.map((r) => r.id);
  const items = rows.map(rowToListItem);
  const issueIds = [...new Set(rows.map((r) => r.issueId).filter((v): v is string => v != null))];
  const [costMap, issueRefs, liveMap, openPhases] = await Promise.all([
    usageTotalsByRun(ids),
    loadIssueRefs(issueIds),
    loadRunLivenessByRunIds(ids),
    loadOpenPhaseByRunIds(items.filter((i) => i.lane === 'run_session').map((i) => i.id)),
  ]);
  return items.map((item, index) => {
    const r = rows[index] as RunRow;
    const ref = r.issueId ? issueRefs.get(r.issueId) : undefined;
    const residentMaster = residentMasterOn(item.lane, liveMap.get(r.id));
    return {
      ...item,
      ...withStep(item.lane, r.currentStep, openPhases.get(r.id), item.group, residentMaster),
      issueRef: ref?.issueRef ?? null,
      issueTitle: ref?.issueTitle ?? null,
      issueStatus: ref?.issueStatus ?? null,
      cost: costMap.get(r.id) ?? EMPTY_COST,
      liveJobs: liveMap.get(r.id)?.liveJobs ?? 0,
      lastSessionBeatAt: liveMap.get(r.id)?.beat ?? null,
      residentMaster,
    };
  });
}

export { EMPTY_COST as PIPELINE_RUN_EMPTY_COST };
