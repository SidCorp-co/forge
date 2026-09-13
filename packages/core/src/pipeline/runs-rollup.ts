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

import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import {
  agentSessions,
  devices,
  issues,
  type JobStatus,
  jobs,
  type PipelineRunKind,
  type PipelineRunStatus,
  pipelineRuns,
  projects,
  terminalAgentSessionStatuses,
  usageRecords,
} from '../db/schema.js';
import { RETRY_MAX_ROUNDS, readAutoRetryPayload } from '../jobs/retry.js';
import { formatIssueRef } from '../lib/issue-ref.js';

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
  // cm:guard this counts JOBS, never occupancy — `agent_sessions` has no `job_id` and hangs off `pipelineRunId`, so a master-lane run reads `liveJobs: 0` while fully live. Reading 0 as "nothing left working on it" is what made 14 heartbeating runs look like a leak (2026-09-12); confirm against `lastSessionBeatAt` below, which is that confirmation carried on the same row.
  liveJobs: number;
  /**
   * ISS-998 — the newest heartbeat of any non-terminal `agent_sessions` row on
   * this run, or `null` where the run has none.
   */
  // cm:guard this is the OTHER half of `liveJobs` and it rides on the same row because a caller that has to fetch it separately cannot get a consistent answer: `agent_sessions` is paged, the set moves under an offset walk, and a session that ends between two pages takes a still-running one off the end of the list with it. One query, one snapshot, both facts (ISS-998).
  // cm:guard graded on the BEAT and never on `status === 'running'`: the sweeper fails a silent session on its own schedule, so between a box dying and the sweep there are `running` rows with hours-old heartbeats, and taking those as proof of life keeps an abandoned run uncounted for as long as the reaper is behind.
  lastSessionBeatAt: string | null;
  /** ISS-411 — per-attempt device/retry timeline (jobs-sourced). */
  attempts: PipelineRunAttempt[];
  /** ISS-411 — round-robin headline; null when the run never retried. */
  retrySummary: PipelineRunRetrySummary | null;
}

// cm:why the list endpoint stays cheap by omitting the per-step and per-attempt rollups, one query each; only the single-run summary pays for them
export type PipelineRunListItem = Omit<PipelineRunSummary, 'steps' | 'attempts' | 'retrySummary'>;

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
    // cm:guard `usage_records.session_id` is an `agent_sessions.id` and NOT a job id (verified on beta, ISS-308), so the run is reached by joining that table rather than by reading a column named for a job; the `::uuid` cast is guarded because the column is text and one non-uuid row would fail the whole query.
    .from(usageRecords)
    .innerJoin(agentSessions, sql`${agentSessions.id} = ${usageRecords.sessionId}::uuid`)
    .where(
      and(
        eq(agentSessions.pipelineRunId, runId),
        sql`${usageRecords.sessionId} ~ '^[0-9a-fA-F-]{36}$'`,
      ),
    );

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
    // cm:edge contract -> packages/core/src/db/schema.ts — the ISS-877 cause token is on `agent_sessions.failure_reason`, NOT on the job row: `jobs.failure_reason` is the classifier's free-text sentence and `jobs.failure_kind` is the four-value retry axis, so a reader that wants to tell a spend cap from a disk-full MUST come through this join or it is back to rendering one label for every death.
    .leftJoin(agentSessions, eq(agentSessions.id, jobs.agentSessionId))
    .where(eq(jobs.pipelineRunId, runId))
    .orderBy(asc(jobs.queuedAt));

  // cm:guard the device map is built over EVERY device named anywhere in the retry chain, not over the rows already loaded: `_autoRetry.target` can name a box no attempt has run on yet, and resolving only the loaded rows leaves that target rendered as a bare uuid.
  const nameById = new Map<string, string>();
  for (const r of rows) {
    if (r.deviceId && r.deviceName) nameById.set(r.deviceId, r.deviceName);
  }

  const attempts: PipelineRunAttempt[] = rows.map((r) => {
    // `readAutoRetryPayload` always returns the zero state; only surface it
    // when the row actually carries `_autoRetry` (i.e. it is a retry chain).
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

  // Headline from the most-recent attempt that carries rotation state.
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
    // cm:why 0 is the honest default for a caller that did not batch the count — never a guess about liveness
    liveJobs: 0,
    // cm:why `null` is "this caller did not load it", which is the same thing a reader does with "this run has no session": neither is a claim that the run is dead
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
    // cm:guard load this from the same batched helper as the list surface and never leave the `rowToListItem` default standing — a spread whose `liveJobs: 0` is not overridden makes the detail endpoint answer 0 for EVERY run, which is the run-liveness lie ISS-789 exists to remove and is what it shipped as for the whole of ISS-789's first half
    liveJobs: liveMap.get(runId)?.liveJobs ?? 0,
    // cm:guard the same rule as `liveJobs` above: loaded from the batched helper, never left on `rowToListItem`'s null — a detail endpoint answering `null` for every run says "no session" about runs that have one
    lastSessionBeatAt: liveMap.get(runId)?.beat ?? null,
    steps,
    cost,
    attempts: attemptRollup.attempts,
    retrySummary: attemptRollup.retrySummary,
  };
}

/**
 * Cost rollup for many runs in one round-trip. Returns a map keyed by run id.
 * Runs with no usage rows are absent from the map; callers should fall back
 * to {@link EMPTY_COST}.
 */
// cm:guard the status lists are BUILT from the shared constants rather than spelled into the SQL: a status added to `jobStatuses` or `terminalAgentSessionStatuses` and not to a literal here changes what "live" means with nothing going red, and the two halves of this query would then disagree with every other reader of the same tables.
const LIVE_JOB_STATUSES = [
  'queued',
  'dispatched',
  'running',
] as const satisfies readonly JobStatus[];
const sqlList = (values: readonly string[]) =>
  sql.join(
    values.map((v) => sql`${v}`),
    sql`, `,
  );

/** Both halves of run liveness for many runs, in ONE statement. */
// cm:guard ONE statement and not two in a `Promise.all`: read-committed gives each statement its own snapshot, so a handoff that ends a session and starts a job can be straddled — the job count reads the state before it and the heartbeat reads the state after, and the run comes back claiming no job AND no session when it always had one of them. That impossible pair is exactly what the stalled count acts on (ISS-998).
// cm:why batched like `loadCostByRunIds`: the list renders up to `limit` runs, and a per-run pair of counts would make the honest answer cost more than the dishonest one (ISS-789).
// cm:edge contract -> packages/web-v2/src/features/agents/stalled-runs.ts — `stalledRuns` reads `liveJobs` and `lastSessionBeatAt` together; a run counted on one of them alone is either a live master-lane run called dead or an orphan left uncounted.
async function loadRunLivenessByRunIds(
  runIds: string[],
): Promise<Map<string, { liveJobs: number; beat: string | null }>> {
  const out = new Map<string, { liveJobs: number; beat: string | null }>();
  if (runIds.length === 0) return out;
  const rows = await db
    .select({
      runId: pipelineRuns.id,
      // cm:guard the JOB half counts `queued`, `dispatched` and `running` and nothing else — `held` is a deliberate shape that is not work in flight, and counting it would keep a parked run out of the stalled band forever
      n: sql<number>`(SELECT count(*) FROM ${jobs} j WHERE j.pipeline_run_id = ${pipelineRuns.id} AND j.status IN (${sqlList(LIVE_JOB_STATUSES)}))`.mapWith(
        Number,
      ),
      // cm:guard the SESSION half is the newest beat of a NON-TERMINAL session; a terminal row's last heartbeat is a fact about when it stopped, and reading it as liveness keeps every finished run out of the count
      beat: sql<Date | null>`(SELECT max(s.last_heartbeat_at) FROM ${agentSessions} s WHERE s.pipeline_run_id = ${pipelineRuns.id} AND s.status NOT IN (${sqlList(terminalAgentSessionStatuses)}))`,
    })
    .from(pipelineRuns)
    .where(inArray(pipelineRuns.id, runIds));
  for (const r of rows)
    if (r.runId) out.set(r.runId, { liveJobs: Number(r.n), beat: toIso(r.beat) });
  return out;
}

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
    // agent_sessions.id, not a job id; verified beta ISS-308). Guard the cast.
    .from(usageRecords)
    .innerJoin(agentSessions, sql`${agentSessions.id} = ${usageRecords.sessionId}::uuid`)
    .where(
      and(
        inArray(agentSessions.pipelineRunId, runIds),
        sql`${usageRecords.sessionId} ~ '^[0-9a-fA-F-]{36}$'`,
      ),
    )
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
