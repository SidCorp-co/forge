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

import { eq, inArray, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import {
  agentSessions,
  issues,
  type PipelineRunKind,
  type PipelineRunStatus,
  pipelineRuns,
  projects,
  usageRecords,
} from '../db/schema.js';
import { type RunGate, readRunGate } from '../devices/gate-report.js';
import { type RunPolicy, readRunPolicy } from '../devices/policy-copy.js';
import { isoOf, isoOrNull } from '../lib/iso-time.js';
import { formatIssueRef } from '../lib/issue-ref.js';
import { usageSessionMatch } from '../usage-records/rollup.js';
import {
  loadAttemptsForRun,
  type PipelineRunAttempt,
  type PipelineRunRetrySummary,
} from './runs-attempts.js';
import { groupTitlesOf, loadGroupTitles } from './runs-group-titles.js';
import {
  groupOf,
  laneOf,
  type PipelineRunGroup,
  type PipelineRunLane,
  type PipelineRunStep,
  type ResidentMaster,
  stepOf,
} from './runs-lane.js';
import {
  loadRunLivenessByRunIds,
  type RunBlock,
  type RunHold,
  type RunLiveness,
  type RunReading,
  residentMasterOn,
} from './runs-liveness.js';

export type { PipelineRunAttempt, PipelineRunRetrySummary } from './runs-attempts.js';
export type {
  PipelineRunGroup,
  PipelineRunLane,
  PipelineRunStep,
  ResidentMaster,
} from './runs-lane.js';

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

export interface PipelineRunSummary {
  id: string;
  projectId: string;
  /** The slug of the run's own project, so a reader in any org can link the run's issue and session. */
  projectSlug: string;
  issueId: string | null;
  lane: PipelineRunLane;
  step: PipelineRunStep;
  /** ISS-1273 — where the group came from and, where there is none, why. `runIssues` IS
   *  `group.issues`, as `currentStep` is `step.step`. */
  group: PipelineRunGroup;
  /** ISS-1273 — the canonical keys this run was opened over; empty off the run-session lane. */
  runIssues: string[];
  /** ISS-460 — human ref (`ISS-<seq>`) of the run's issue; null for pm/system/interactive runs. */
  issueRef: string | null;
  /** ISS-460 — title of the run's issue; null when the run has no issue. */
  issueTitle: string | null;
  /** ISS-1228 — each `group` issue's title by its key; a key no issue of the project has is absent. */
  groupTitles: Record<string, string>;
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
  /** What the run's agent is doing, the one reading every surface shows (`runs-liveness.ts`). */
  reading: RunReading | null;
  /** Why core holds the run's job and whether it sends it again itself, where it holds one. */
  hold: RunHold | null;
  /** What a box reports its blocked session on the run waits on. */
  block: RunBlock | null;
  /** When core ends a session on the run that has not checked in since it opened. */
  checkInBy: string | null;
  /** When the run's work started: the earliest start of any session on it. */
  runningSince: string | null;
  /** The run's newest session. */
  sessionId: string | null;
  /** ISS-1335 — the live master session on a `master`-lane run; `null` off that lane, and on a
   *  master run nothing holds any more. A session of another kind never fills it. */
  residentMaster: ResidentMaster | null;
  /** ISS-411 — per-attempt device/retry timeline (jobs-sourced). */
  attempts: PipelineRunAttempt[];
  /** ISS-411 — round-robin headline; null when the run never retried. */
  retrySummary: PipelineRunRetrySummary | null;
  /** ISS-1192 — the box's declaration gate when this run opened; `null` where
   *  the box reported none. The list row omits it: it carries a breakdown. */
  gateAtOpen: RunGate | null;
  /** ISS-1303 — the copy of the policy the box named when it opened this run; `null` for a
   *  run opened before the stamp existed. The list row omits it with the gate. */
  policyAtOpen: RunPolicy | null;
}

export type PipelineRunListItem = Omit<
  PipelineRunSummary,
  'projectSlug' | 'steps' | 'attempts' | 'retrySummary' | 'gateAtOpen' | 'policyAtOpen'
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

    const startedAt = isoOrNull(r.startedAt);
    const finishedAt =
      status === 'completed' || status === 'failed' ? isoOrNull(r.finishedAt) : null;
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
    groupTitles: {},
    kind: row.kind,
    status: row.status,
    startedAt: isoOf(row.startedAt),
    finishedAt: isoOrNull(row.finishedAt),
    cost: EMPTY_COST,
    liveJobs: 0,
    lastSessionBeatAt: null,
    ...readingFields(undefined),
    residentMaster: null,
  };
}

/** The reading and what explains it, off one liveness row, so every read of a run answers alike. */
function readingFields(l: RunLiveness | undefined) {
  return {
    reading: l?.reading ?? null,
    hold: l?.hold ?? null,
    block: l?.block ?? null,
    checkInBy: l?.checkInBy ?? null,
    runningSince: l?.runningSince ?? null,
    sessionId: l?.sessionId ?? null,
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

/** ISS-1273 — a box-driven run's step is its open `run_journal` row. Two open rows mean a
 *  driver never closed the earlier phase; the newest is the one it is on, the row
 *  `phase-journal.ts:resumePoint` resumes at, and `DISTINCT ON` settles that in the query rather
 *  than in whichever order rows arrived. */
async function loadOpenPhaseByRunIds(runIds: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (runIds.length === 0) return out;
  const rows = (await db.execute(sql`
    SELECT DISTINCT ON (run_id) run_id, phase
      FROM run_journal
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

  const listItem = rowToListItem(row);
  const [steps, cost, attemptRollup, issueRefs, liveMap, openPhase, [project]] = await Promise.all([
    loadStepsForRun(runId),
    loadCostForRun(runId),
    loadAttemptsForRun(runId),
    loadIssueRefs(row.issueId ? [row.issueId] : []),
    loadRunLivenessByRunIds([runId]),
    loadOpenPhaseByRunIds(listItem.lane === 'run_session' ? [runId] : []),
    db.select({ slug: projects.slug }).from(projects).where(eq(projects.id, row.projectId)),
  ]);
  if (!project)
    throw new Error(`pipeline run ${runId} names project ${row.projectId}, which is gone`);
  const groupTitles = groupTitlesOf(listItem, await loadGroupTitles([listItem]));

  const ref = row.issueId ? issueRefs.get(row.issueId) : undefined;
  const residentMaster = residentMasterOn(listItem.lane, liveMap.get(runId));
  return {
    ...listItem,
    projectSlug: project.slug,
    ...withStep(
      listItem.lane,
      row.currentStep,
      openPhase.get(runId),
      listItem.group,
      residentMaster,
    ),
    issueRef: ref?.issueRef ?? null,
    issueTitle: ref?.issueTitle ?? null,
    groupTitles,
    liveJobs: liveMap.get(runId)?.liveJobs ?? 0,
    lastSessionBeatAt: liveMap.get(runId)?.beat ?? null,
    ...readingFields(liveMap.get(runId)),
    residentMaster,
    steps,
    cost,
    attempts: attemptRollup.attempts,
    retrySummary: attemptRollup.retrySummary,
    gateAtOpen: readRunGate(row.metadata, runId),
    policyAtOpen: readRunPolicy(row.metadata, runId),
  };
}

/**
 * Cost rollup for many runs in one round-trip. Returns a map keyed by run id.
 * Runs with no usage rows are absent from the map; callers should fall back
 * to {@link EMPTY_COST}.
 */
export async function loadCostByRunIds(
  runIds: string[],
): Promise<Map<string, PipelineRunCostSummary>> {
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
  const items = rows.map(rowToListItem);
  const issueIds = [...new Set(rows.map((r) => r.issueId).filter((v): v is string => v != null))];
  const [costMap, issueRefs, liveMap, openPhases, groupTitles] = await Promise.all([
    loadCostByRunIds(ids),
    loadIssueRefs(issueIds),
    loadRunLivenessByRunIds(ids),
    loadOpenPhaseByRunIds(items.filter((i) => i.lane === 'run_session').map((i) => i.id)),
    loadGroupTitles(items),
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
      groupTitles: groupTitlesOf(item, groupTitles),
      cost: costMap.get(r.id) ?? EMPTY_COST,
      liveJobs: liveMap.get(r.id)?.liveJobs ?? 0,
      lastSessionBeatAt: liveMap.get(r.id)?.beat ?? null,
      ...readingFields(liveMap.get(r.id)),
      residentMaster,
    };
  });
}

export { EMPTY_COST as PIPELINE_RUN_EMPTY_COST };
