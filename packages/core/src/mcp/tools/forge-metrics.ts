import { z } from 'zod';
import { jobTypes } from '../../db/schema.js';
import { BUCKETS, METRICS, runTimeseries, stepDurationsForProject } from '../../metrics/queries.js';
import {
  buildRetryRescuesReport,
  buildSessionFailuresReport,
} from '../../metrics/session-failures-report.js';
import {
  assertPrincipalIsMember,
  type ContextScopedMcpToolFactory,
  zodToMcpSchema,
} from './lib.js';

const stepEnum = z.enum(jobTypes);

const _stepDurationsInputSchema = z
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

const RETRY_RESCUES_DESCRIPTION =
  'Retry failures later rescued by a successful retry, reconstructed from historical job chains. Requires project membership. Groups results by the original failure reason. Params: `projectId` and `days` (1..90, default 30). Returns `{ rows: [{ failureKind, failureReason, rescues, lastRescuedAt }], total, windowDays, projectId }`.';

export const forgeMetricsProjectRetryRescuesTool: ContextScopedMcpToolFactory = (ctx) => ({
  name: 'forge_metrics.project_retry_rescues',
  description: RETRY_RESCUES_DESCRIPTION,
  inputSchema: zodToMcpSchema(retryRescuesInputSchema),
  handler: async (args) => {
    const input = retryRescuesInputSchema.parse(args);
    await assertPrincipalIsMember(ctx.principal, input.projectId);
    return buildRetryRescuesReport(input.projectId, input.days);
  },
});

const SESSION_FAILURES_DESCRIPTION =
  'Failed agent sessions grouped by ISS-877 failure cause. Requires project membership. Params: `projectId` and `days` (1..90, default 30). Counts sessions whose STATUS is `failed` or `cancelled_stale`. Returns `{ rows: [{ cause, origin, sessions, isRealFailure, lastAt }], total, unclassified, unclassifiedRate, nonFailedWithFailureReason, resumeContinuity, windowDays, projectId }`. `resumeContinuity` (ISS-887) answers, over the SAME project and window, whether each attempt continued the prior attempt CLI transcript: `{ offered, resumed, dropped, dropRate, rows: [{ reason, sessions }] }`, where `reason` is one of the six `ResumeDropReason` values (`failure_action` on a cross-box failover, `rotation`, `stage_pool`, `pin_stale`, `resume_bound_tokens`, `resume_bound_reopen_cycles`); rows written before ISS-897 may also carry `device_tripped`, which named a first-dispatch drop that no longer exists. `offered` counts only attempts that HAD a prior session — a first attempt has nothing to continue and is excluded, so the rate never dilutes as the project starts more fresh work. It carries its own denominator and its own filter, and is deliberately NOT restricted to failed sessions: a resume is dropped on healthy dispatches too. An empty block means no attempt in the window was offered a prior session, not a broken query. `nonFailedWithFailureReason` counts sessions at any other status that still carry a reason — `completed` (the ISS-759 completed-yet-failed shape) and live `running`/`queued` rows the I1 trigger stamped — reported rather than silently dropped. Legacy rows (`job_failed`, free text) resolve to `unclassified` at read time — a high historical rate is the honest measurement of the era before causes were recorded, not a bug.';

export const forgeMetricsSessionFailuresTool: ContextScopedMcpToolFactory = (ctx) => ({
  name: 'forge_metrics.session_failures',
  description: SESSION_FAILURES_DESCRIPTION,
  inputSchema: zodToMcpSchema(sessionFailuresInputSchema),
  handler: async (args) => {
    const input = sessionFailuresInputSchema.parse(args);
    await assertPrincipalIsMember(ctx.principal, input.projectId);
    return buildSessionFailuresReport(input.projectId, input.days);
  },
});
