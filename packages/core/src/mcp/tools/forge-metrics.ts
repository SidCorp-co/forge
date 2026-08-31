import { z } from 'zod';
import { jobTypes } from '../../db/schema.js';
import {
  BUCKETS,
  METRICS,
  resumeDropsForProject,
  retryRescues,
  runTimeseries,
  sessionFailures,
  stepDurationsAcrossProjects,
  stepDurationsForProject,
} from '../../metrics/queries.js';
import {
  FAILURE_CAUSE_ORIGIN,
  type FailureCause,
  isRealFailureCause,
  resolveFailureCause,
} from '../../pipeline/failure-causes.js';
import {
  assertPrincipalIsMember,
  type ContextScopedMcpToolFactory,
  loadVisibleProjectIdsForPrincipal,
  zodToMcpSchema,
} from './lib.js';

const stepEnum = z.enum(jobTypes);

const stepDurationsInputSchema = z
  .object({
    days: z.number().int().min(1).max(90).optional().default(30),
    step: stepEnum.optional(),
  })
  .strict();

const projectInputSchema = z
  .object({
    projectId: z.uuid(),
    days: z.number().int().min(1).max(90).optional().default(30),
    step: stepEnum.optional(),
    // cm:why with a per-state runner pool one step's samples span several boxes/model tiers, so the step-only grouping averages the very difference the operator pinned the pool to measure
    breakdown: z.enum(['device', 'model']).optional(),
  })
  .strict();

const retryRescuesInputSchema = z
  .object({
    projectId: z.uuid(),
    days: z.number().int().min(1).max(90).optional().default(30),
  })
  .strict();

const sessionFailuresInputSchema = z
  .object({
    projectId: z.uuid(),
    days: z.number().int().min(1).max(90).optional().default(30),
  })
  .strict();

function num(x: number | string | null | undefined): number {
  if (x === null || x === undefined) return 0;
  return typeof x === 'number' ? x : Number(x);
}

export const forgeMetricsStepDurationsTool: ContextScopedMcpToolFactory = (ctx) => ({
  name: 'forge_metrics.step_durations',
  description:
    'Aggregated pipeline-step durations (p50/p95/avg/cost/sample size) over `pipeline_run_step_durations` across the projects you can access (projects you own or are a member of). Filterable by `days` (1..90, default 30) and `step` (job type). Returns `{ rows: [{ projectId, projectSlug, step, p50, p95, avg, totalCostUsd, n }], windowDays }`.',
  inputSchema: zodToMcpSchema(stepDurationsInputSchema),
  handler: async (args) => {
    const input = stepDurationsInputSchema.parse(args);
    const visibleIds = await loadVisibleProjectIdsForPrincipal(ctx.principal);
    if (visibleIds.length === 0) {
      return { rows: [], windowDays: input.days };
    }

    const result = await stepDurationsAcrossProjects(visibleIds, input.days, input.step);
    const rows = result.map((r) => ({
      projectId: r.project_id,
      projectSlug: r.project_slug,
      step: r.step,
      p50: num(r.p50_s),
      p95: num(r.p95_s),
      avg: num(r.avg_s),
      totalCostUsd: num(r.total_cost),
      n: num(r.n),
    }));
    return { rows, windowDays: input.days };
  },
});

export const forgeMetricsProjectRetryRescuesTool: ContextScopedMcpToolFactory = (ctx) => ({
  name: 'forge_metrics.project_retry_rescues',
  description:
    'Retry failures later rescued by a successful retry, reconstructed from historical job chains. Requires project membership. Groups results by the original failure reason. Params: `projectId` and `days` (1..90, default 30). Returns `{ rows: [{ failureKind, failureReason, rescues, lastRescuedAt }], total, windowDays, projectId }`.',
  inputSchema: zodToMcpSchema(retryRescuesInputSchema),
  handler: async (args) => {
    const input = retryRescuesInputSchema.parse(args);
    await assertPrincipalIsMember(ctx.principal, input.projectId);

    const result = await retryRescues(input.projectId, input.days);
    const rows = result.map((row) => ({
      failureKind: row.failure_kind,
      failureReason: row.failure_reason,
      rescues: num(row.rescues),
      lastRescuedAt:
        row.last_rescued_at instanceof Date
          ? row.last_rescued_at.toISOString()
          : String(row.last_rescued_at),
    }));
    return {
      rows,
      total: rows.reduce((total, row) => total + row.rescues, 0),
      windowDays: input.days,
      projectId: input.projectId,
    };
  },
});

// cm:guard the two statuses that mean the session itself ended badly. `completed` and `completed_via_recovery` are deliberately absent even when they carry a `failure_reason` — a recovered session succeeded, and counting its old reason would report a rescue as a death.
const FAILED_SESSION_STATUSES: ReadonlySet<string> = new Set(['failed', 'cancelled_stale']);

export interface ResumeContinuityRow {
  reason: string;
  sessions: number;
}

export interface ResumeContinuity {
  offered: number;
  resumed: number;
  dropped: number;
  dropRate: number;
  rows: ResumeContinuityRow[];
}

/**
 * ISS-887 — of the attempts that HAD a prior transcript to continue, how many continued it and,
 * for the rest, which of the seven `ResumeDropReason` paths took it away.
 *
 * Reads the durable record `resolveResumePolicy`/`finalizeResumeForDevice` stamp on
 * `agent_sessions.metadata.resume`, over the same project and window as the failure histogram
 * beside it — which is the whole point of it living here. A drop rate on its own says nothing:
 * the question it answers ("did attempt 2 resume, or start cold?") is only meaningful next to
 * what killed attempt 1.
 */
// cm:guard `offered` is the denominator and it is defined by `priorClaudeSessionId IS NOT NULL`, never by counting rows. That predicate is what keeps attempt 1 out: an attempt with no prior session to continue is the normal shape of a first try, and folding those into the denominator would make the rate shrink as the project does MORE fresh work.
// cm:guard this must NOT inherit the failure histogram's status filter. A resume is dropped on healthy dispatches too — restricting it to `failed`/`cancelled_stale` rows would measure the drop rate of attempts that later died, report it as the drop rate, and leave both numbers wrong.
async function loadResumeContinuity(projectId: string, days: number): Promise<ResumeContinuity> {
  const result = await resumeDropsForProject(projectId, days);
  let offered = 0;
  let dropped = 0;
  const rows: ResumeContinuityRow[] = [];
  for (const row of result) {
    const sessions = num(row.sessions);
    offered += sessions;
    if (row.drop_reason === null) continue;
    dropped += sessions;
    rows.push({ reason: row.drop_reason, sessions });
  }
  rows.sort((a, b) => b.sessions - a.sessions || a.reason.localeCompare(b.reason));
  return {
    offered,
    resumed: offered - dropped,
    dropped,
    dropRate: offered === 0 ? 0 : dropped / offered,
    rows,
  };
}

export interface SessionFailureRow {
  cause: FailureCause;
  origin: string;
  sessions: number;
  isRealFailure: boolean;
  lastAt: string | null;
}

/**
 * ISS-877 — group failed sessions by cause so the taxonomy is measurable
 * rather than merely stored.
 *
 * `unclassified` is a row like any other, and `unclassifiedRate` is returned
 * beside the rows. That is the invariant, not a nicety: an unclassified rate
 * nobody can see is how `job_failed` survived long enough to swallow every
 * agent-side failure in the system. The rate will read HIGH at first and
 * should — rows written before this shipped resolve to `unclassified` through
 * `LEGACY_CAUSE_ALIAS`, which is an accurate measurement of an era that
 * classified nothing. The number worth watching is the rate over rows written
 * after it.
 *
 * A session counts as failed when its STATUS says so, not merely because it
 * carries a `failure_reason`. The two disagree on live data: 37 forge-beta
 * sessions sit at `completed` holding one (30 `orphan_under_terminal_run`, 6
 * `heartbeat_timeout`), the ISS-759 shape the `cm:guard` on
 * `agent-sessions/routes.ts` names. Counting those as deaths would make the one
 * surface built against a lying session row repeat the lie, so they are
 * excluded from the histogram and returned as `nonFailedWithFailureReason`
 * instead — a number with a name beats a filter nobody sees. The field spans
 * every status outside the failed pair, LIVE ones included: the I1 trigger
 * stamps a cause on a session that is still `running`, and a row claiming to
 * be running and failed at once is the same lie one tense earlier.
 *
 * The mirror case is included rather than excluded: a `failed` session holding
 * NO reason at all is counted, as `unclassified`. It is the purest form of the
 * defect this issue exists to end, and a query that asked for a reason before
 * counting a failure could never see it.
 */
// cm:guard `unclassified` must stay a first-class row here — filtering it out, folding it into "other", or reporting only the classified share re-hides the exact hole this tool exists to expose
// cm:guard the status filter and `nonFailedWithFailureReason` are one mechanism: rows excluded from the histogram must stay counted somewhere in the response. Narrowing the WHERE without carrying the excluded rows out under their own name is how a metric starts reading clean because it stopped looking.
// cm:guard a failed session with a NULL `failure_reason` is IN, and is the most important row here — it recorded nothing at all, which is the hole this tool measures. Re-adding `failure_reason IS NOT NULL` to the WHERE drops it from both sides of `unclassifiedRate`, so the rate improves precisely because the worst rows stopped being counted.
export const forgeMetricsSessionFailuresTool: ContextScopedMcpToolFactory = (ctx) => ({
  name: 'forge_metrics.session_failures',
  description:
    'Failed agent sessions grouped by ISS-877 failure cause. Requires project membership. Params: `projectId` and `days` (1..90, default 30). Counts sessions whose STATUS is `failed` or `cancelled_stale`. Returns `{ rows: [{ cause, origin, sessions, isRealFailure, lastAt }], total, unclassified, unclassifiedRate, nonFailedWithFailureReason, resumeContinuity, windowDays, projectId }`. `resumeContinuity` (ISS-887) answers, over the SAME project and window, whether each attempt continued the prior attempt CLI transcript: `{ offered, resumed, dropped, dropRate, rows: [{ reason, sessions }] }`, where `reason` is one of the seven `ResumeDropReason` values (`failure_action` on a cross-box failover, `rotation`, `stage_pool`, `pin_stale`, `device_tripped`, `resume_bound_tokens`, `resume_bound_reopen_cycles`). `offered` counts only attempts that HAD a prior session — a first attempt has nothing to continue and is excluded, so the rate never dilutes as the project starts more fresh work. It carries its own denominator and its own filter, and is deliberately NOT restricted to failed sessions: a resume is dropped on healthy dispatches too. An empty block means no attempt in the window was offered a prior session, not a broken query. `nonFailedWithFailureReason` counts sessions at any other status that still carry a reason — `completed` (the ISS-759 completed-yet-failed shape) and live `running`/`queued` rows the I1 trigger stamped — reported rather than silently dropped. Legacy rows (`job_failed`, free text) resolve to `unclassified` at read time — a high historical rate is the honest measurement of the era before causes were recorded, not a bug.',
  inputSchema: zodToMcpSchema(sessionFailuresInputSchema),
  handler: async (args) => {
    const input = sessionFailuresInputSchema.parse(args);
    await assertPrincipalIsMember(ctx.principal, input.projectId);

    const result = await sessionFailures(input.projectId, input.days);

    const byCause = new Map<FailureCause, { sessions: number; lastAt: Date | null }>();
    let nonFailedWithFailureReason = 0;
    for (const row of result) {
      if (!FAILED_SESSION_STATUSES.has(row.status ?? '')) {
        nonFailedWithFailureReason += num(row.sessions);
        continue;
      }
      const cause = resolveFailureCause(row.failure_reason);
      const prev = byCause.get(cause);
      const lastAt = row.last_at ? new Date(row.last_at) : null;
      byCause.set(cause, {
        sessions: (prev?.sessions ?? 0) + num(row.sessions),
        lastAt:
          prev?.lastAt && lastAt
            ? prev.lastAt > lastAt
              ? prev.lastAt
              : lastAt
            : (lastAt ?? prev?.lastAt ?? null),
      });
    }

    const rows: SessionFailureRow[] = [...byCause.entries()]
      .map(([cause, agg]) => ({
        cause,
        origin: FAILURE_CAUSE_ORIGIN[cause],
        sessions: agg.sessions,
        isRealFailure: isRealFailureCause(cause),
        lastAt: agg.lastAt ? agg.lastAt.toISOString() : null,
      }))
      .sort((a, b) => b.sessions - a.sessions || a.cause.localeCompare(b.cause));

    const total = rows.reduce((sum, row) => sum + row.sessions, 0);
    const unclassified = byCause.get('unclassified')?.sessions ?? 0;
    return {
      rows,
      total,
      unclassified,
      unclassifiedRate: total === 0 ? 0 : unclassified / total,
      nonFailedWithFailureReason,
      resumeContinuity: await loadResumeContinuity(input.projectId, input.days),
      windowDays: input.days,
      projectId: input.projectId,
    };
  },
});

export const forgeMetricsProjectStepDurationsTool: ContextScopedMcpToolFactory = (ctx) => ({
  name: 'forge_metrics.project_step_durations',
  description:
    'Aggregated pipeline-step durations (p50/p95/avg/cost/sample size) for one project over `pipeline_run_step_durations`. Requires project membership. Filterable by `days` (1..90, default 30) and `step`. Returns `{ rows: [{ step, p50, p95, avg, totalCostUsd, n }], windowDays, projectId }`. Pass `breakdown: "device" | "model"` to split each step by the runner device or the model tier that ran it — the split a per-state runner pool (`pipelineConfig.states[x].deviceIds`) needs, since a pooled step averages several boxes otherwise; each row then also carries `deviceId` / `modelUsed` (null for rows predating the column).',
  inputSchema: zodToMcpSchema(projectInputSchema),
  handler: async (args) => {
    const input = projectInputSchema.parse(args);
    await assertPrincipalIsMember(ctx.principal, input.projectId);

    const result = await stepDurationsForProject(
      input.projectId,
      input.days,
      input.step,
      input.breakdown,
    );
    const rows = result.map((r) => ({
      step: r.step,
      ...(input.breakdown === 'device' ? { deviceId: r.breakdown_key ?? null } : {}),
      ...(input.breakdown === 'model' ? { modelUsed: r.breakdown_key ?? null } : {}),
      p50: num(r.p50_s),
      p95: num(r.p95_s),
      avg: num(r.avg_s),
      totalCostUsd: num(r.total_cost),
      n: num(r.n),
    }));
    return { rows, windowDays: input.days, projectId: input.projectId };
  },
});

const timeseriesInputSchema = z
  .object({
    projectId: z.uuid(),
    metric: z.enum(METRICS),
    days: z.number().int().min(1).max(90).optional().default(30),
    bucket: z.enum(BUCKETS).optional().default('day'),
    groupBy: z.literal('step').optional(),
  })
  .strict();

export const forgeMetricsProjectTimeseriesTool: ContextScopedMcpToolFactory = (ctx) => ({
  name: 'forge_metrics.project_timeseries',
  description:
    'Project time-series trend for the v2 dashboard charts (ISS-380). Returns a dense (gap-filled) bucketed series for one `metric` of cost | throughput | cycle_time | queue_wait | runner_utilization | cache_hit_rate, derived entirely from existing tables. Requires project membership. Params: `projectId`, `metric`, `days` (1..90, default 30), `bucket` (day|hour, default day), and `groupBy=step` (cost only). Returns `{ metric, bucket, days, groupBy, series }`.',
  inputSchema: zodToMcpSchema(timeseriesInputSchema),
  handler: async (args) => {
    const input = timeseriesInputSchema.parse(args);
    await assertPrincipalIsMember(ctx.principal, input.projectId);
    return runTimeseries({
      projectId: input.projectId,
      metric: input.metric,
      days: input.days,
      bucket: input.bucket,
      groupByStep: input.groupBy === 'step',
    });
  },
});
