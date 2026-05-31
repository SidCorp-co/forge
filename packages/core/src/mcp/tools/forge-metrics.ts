import { sql } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../../db/client.js';
import { jobTypes } from '../../db/schema.js';
import {
  type ContextScopedMcpToolFactory,
  assertPrincipalIsMember,
  loadVisibleProjectIdsForPrincipal,
  zodToMcpSchema,
} from './lib.js';

const stepEnum = z.enum(jobTypes);

const adminInputSchema = z
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
  })
  .strict();

type AggRow = {
  project_id: string;
  project_slug: string | null;
  step: string;
  p50_s: number | string | null;
  p95_s: number | string | null;
  avg_s: number | string | null;
  total_cost: number | string | null;
  n: number | string | null;
};

function num(x: number | string | null | undefined): number {
  if (x === null || x === undefined) return 0;
  return typeof x === 'number' ? x : Number(x);
}

export const forgeMetricsAdminStepDurationsTool: ContextScopedMcpToolFactory = (ctx) => ({
  name: 'forge_metrics.admin_step_durations',
  description:
    'Aggregated pipeline-step durations (p50/p95/avg/cost/sample size) over `pipeline_run_step_durations` across the projects you can access (projects you own or are a member of). Filterable by `days` (1..90, default 30) and `step` (job type). Returns `{ rows: [{ projectId, projectSlug, step, p50, p95, avg, totalCostUsd, n }], windowDays }`.',
  inputSchema: zodToMcpSchema(adminInputSchema),
  handler: async (args) => {
    const input = adminInputSchema.parse(args);
    const visibleIds = await loadVisibleProjectIdsForPrincipal(ctx.principal);
    if (visibleIds.length === 0) {
      return { rows: [], windowDays: input.days };
    }

    // Build the id list as a parenthesised parameter list via `sql.join` and
    // use `IN (...)`. Embedding a JS array directly (`= ANY(${visibleIds}::uuid[])`)
    // expands it as a record tuple ($1,$2,...), so `ANY(tuple::uuid[])` is a
    // malformed array literal that throws at query time. Same idiom as
    // projects/health-routes.ts.
    const projectIdList = sql.join(
      visibleIds.map((id) => sql`${id}`),
      sql`, `,
    );
    const stepFilter = input.step ? sql`AND v.step = ${input.step}` : sql``;
    const result = await db.execute(sql`
      SELECT v.project_id,
             p.slug AS project_slug,
             v.step,
             percentile_disc(0.5) WITHIN GROUP (ORDER BY v.duration_seconds) AS p50_s,
             percentile_disc(0.95) WITHIN GROUP (ORDER BY v.duration_seconds) AS p95_s,
             avg(v.duration_seconds)::float AS avg_s,
             sum(v.cost_usd)::float AS total_cost,
             count(*)::int AS n
      FROM pipeline_run_step_durations v
      LEFT JOIN projects p ON p.id = v.project_id
      WHERE v.project_id IN (${projectIdList})
        AND v.started_at >= now() - (${input.days}::int * interval '1 day')
        ${stepFilter}
      GROUP BY v.project_id, p.slug, v.step
      ORDER BY v.project_id, v.step
    `);
    const rows = (result as unknown as AggRow[]).map((r) => ({
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

export const forgeMetricsProjectStepDurationsTool: ContextScopedMcpToolFactory = (ctx) => ({
  name: 'forge_metrics.project_step_durations',
  description:
    'Aggregated pipeline-step durations (p50/p95/avg/cost/sample size) for one project over `pipeline_run_step_durations`. Requires project membership. Filterable by `days` (1..90, default 30) and `step`. Returns `{ rows: [{ step, p50, p95, avg, totalCostUsd, n }], windowDays, projectId }`.',
  inputSchema: zodToMcpSchema(projectInputSchema),
  handler: async (args) => {
    const input = projectInputSchema.parse(args);
    await assertPrincipalIsMember(ctx.principal, input.projectId);

    const stepFilter = input.step ? sql`AND step = ${input.step}` : sql``;
    const result = await db.execute(sql`
      SELECT step,
             percentile_disc(0.5) WITHIN GROUP (ORDER BY duration_seconds) AS p50_s,
             percentile_disc(0.95) WITHIN GROUP (ORDER BY duration_seconds) AS p95_s,
             avg(duration_seconds)::float AS avg_s,
             sum(cost_usd)::float AS total_cost,
             count(*)::int AS n
      FROM pipeline_run_step_durations
      WHERE project_id = ${input.projectId}
        AND started_at >= now() - (${input.days}::int * interval '1 day')
        ${stepFilter}
      GROUP BY step
      ORDER BY step
    `);
    const rows = (result as unknown as Array<Omit<AggRow, 'project_id' | 'project_slug'>>).map(
      (r) => ({
        step: r.step,
        p50: num(r.p50_s),
        p95: num(r.p95_s),
        avg: num(r.avg_s),
        totalCostUsd: num(r.total_cost),
        n: num(r.n),
      }),
    );
    return { rows, windowDays: input.days, projectId: input.projectId };
  },
});
