import { z } from 'zod';
import { jobTypes } from '../db/schema.js';
import { type ContextScopedMcpToolFactory, zodToMcpSchema } from '../lib/tool.js';
import { actorFor, projectResource, requireCan } from '../permissions/index.js';
import { BUCKETS, METRICS, runTimeseries, stepDurationsForProject } from './queries.js';

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
    breakdown: z.enum(['device', 'model']).optional(),
  })
  .strict();

function num(x: number | string | null | undefined): number {
  if (x === null || x === undefined) return 0;
  return typeof x === 'number' ? x : Number(x);
}

export const forgeMetricsProjectStepDurationsTool: ContextScopedMcpToolFactory = (ctx) => ({
  name: 'forge_metrics.project_step_durations',
  reach: 'project',
  route: '/api/pipeline',
  grant: 'pipeline:read',
  description:
    'Aggregated pipeline-step durations (p50/p95/avg/cost/sample size) for one project over `pipeline_run_step_durations`. Requires project membership. Filterable by `days` (1..90, default 30) and `step`. Returns `{ rows: [{ step, p50, p95, avg, totalCostUsd, n }], windowDays, projectId }`. Pass `breakdown: "device" | "model"` to split each step by the runner device or the model tier that ran it, since a step run on several boxes averages them otherwise; each row then also carries `deviceId` / `modelUsed` (null for rows predating the column).',
  inputSchema: zodToMcpSchema(projectInputSchema),
  handler: async (args) => {
    const input = projectInputSchema.parse(args);
    await requireCan(actorFor(ctx.principal.userId), 'project.read', projectResource(input.projectId));

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
  reach: 'project',
  route: '/api/projects/:id/metrics/timeseries',
  grant: 'projects:read',
  description:
    'Project time-series trend for the v2 dashboard charts (ISS-380). Returns a dense (gap-filled) bucketed series for one `metric` of cost | throughput | cycle_time | queue_wait | runner_utilization | cache_hit_rate, derived entirely from existing tables. Requires project membership. Params: `projectId`, `metric`, `days` (1..90, default 30), `bucket` (day|hour, default day), and `groupBy=step` (cost only). Returns `{ metric, bucket, days, groupBy, series }`.',
  inputSchema: zodToMcpSchema(timeseriesInputSchema),
  handler: async (args) => {
    const input = timeseriesInputSchema.parse(args);
    await requireCan(actorFor(ctx.principal.userId), 'project.read', projectResource(input.projectId));
    return runTimeseries({
      projectId: input.projectId,
      metric: input.metric,
      days: input.days,
      bucket: input.bucket,
      groupByStep: input.groupBy === 'step',
    });
  },
});
