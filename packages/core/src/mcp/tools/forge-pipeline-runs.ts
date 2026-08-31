/**
 * ISS-102 / ISS-145 — Pure handlers + deprecation shims for the legacy
 * `forge_pipeline_runs.<action>` tool family.
 *
 * The five action functions exported below (list/get/pause/resume/cancel)
 * carry the actual business logic — auth check, db read, control call —
 * and are consumed by both:
 *   1. The consolidated `forge_project_pipeline_runs` dispatcher
 *      (`./forge-project-pipeline-runs.ts`).
 *   2. The legacy shim factories in this file, kept registered for at least
 *      one release so the existing tool names keep working with an
 *      `X-MCP-Deprecation` warning header emitted by `handler.ts`.
 *
 * TODO ISS-145-followup: remove shim factories after the deprecation window
 * closes (≥ 1 release after v0.1.x consolidates).
 */

import { and, desc, eq, type SQL, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { Device } from '../../auth/deviceToken.js';
import { db } from '../../db/client.js';
import { jobs, pipelineRunStatuses, pipelineRuns } from '../../db/schema.js';
import type { McpPrincipal } from '../../middleware/require-pat-or-device.js';
import {
  cancelPipelineRun,
  pausePipelineRun,
  resumePipelineRun,
} from '../../pipeline/runs-control.js';
import { deprecationFor } from '../deprecation.js';
import {
  assertPrincipalIsMember,
  assertPrincipalIsWriter,
  type ContextScopedMcpToolFactory,
  type McpContext,
  principalUserId,
  zodToMcpSchema,
} from './lib.js';
import { buildListEnvelope, overfetch } from './list-envelope.js';
import { assertDeviceOwnerIsMember } from './project-authz.js';

export const pipelineRunsListInputSchema = z
  .object({
    projectId: z.uuid(),
    issueId: z.uuid().optional(),
    status: z.enum(pipelineRunStatuses).optional(),
    limit: z.number().int().min(1).max(200).optional(),
  })
  .strict();

export const pipelineRunsRunIdInputSchema = z.object({ runId: z.uuid() }).strict();

export const pipelineRunsCancelInputSchema = z
  .object({ runId: z.uuid(), parkIssue: z.boolean().optional() })
  .strict();

async function loadRunForPrincipal(principal: McpPrincipal, runId: string) {
  const [row] = await db.select().from(pipelineRuns).where(eq(pipelineRuns.id, runId)).limit(1);
  if (!row) throw new Error('NOT_FOUND: pipeline run not found');
  await assertPrincipalIsMember(principal, row.projectId);
  return row;
}

export async function pipelineRunsListHandler(
  device: Device,
  input: z.infer<typeof pipelineRunsListInputSchema>,
) {
  await assertDeviceOwnerIsMember(device, input.projectId);

  const runsLimit = input.limit ?? 50;
  const conds: SQL[] = [eq(pipelineRuns.projectId, input.projectId)];
  if (input.issueId) conds.push(eq(pipelineRuns.issueId, input.issueId));
  if (input.status) conds.push(eq(pipelineRuns.status, input.status));

  // ISS-428 — scalar projection; OMIT the `metadata` jsonb (unbounded) so a
  // large list stays under the MCP response token cap. Full row via `get`.
  const rows = await db
    .select({
      id: pipelineRuns.id,
      projectId: pipelineRuns.projectId,
      issueId: pipelineRuns.issueId,
      kind: pipelineRuns.kind,
      status: pipelineRuns.status,
      currentStep: pipelineRuns.currentStep,
      startedAt: pipelineRuns.startedAt,
      finishedAt: pipelineRuns.finishedAt,
      createdAt: pipelineRuns.createdAt,
      updatedAt: pipelineRuns.updatedAt,
      // cm:why ISS-789 — `status` alone cannot say whether anything is still working on a run; a correlated count keeps that answer in the same round-trip as the row it describes
      // cm:guard write the identifiers LITERALLY here — do NOT interpolate `${jobs.pipelineRunId}` / `${pipelineRuns.id}`. Drizzle renders a column reference inside a raw sql template UNQUALIFIED (`"id"`, not `"pipeline_runs"."id"`), so inside this subquery the bare `"id"` binds to jobs.id and the correlation becomes `jobs.pipeline_run_id = jobs.id` — always false, count always 0. It compiles, typechecks, and is wrong; it shipped in 65bb8a0b and only real data caught it.
      liveJobs: sql<number>`(
        SELECT count(*)::int FROM jobs lj
        WHERE lj.pipeline_run_id = pipeline_runs.id
          AND lj.status IN ('queued','dispatched','running')
      )`.mapWith(Number),
    })
    .from(pipelineRuns)
    .where(and(...conds))
    .orderBy(desc(pipelineRuns.startedAt))
    .limit(overfetch(runsLimit));

  return buildListEnvelope({
    key: 'runs',
    items: rows,
    limit: runsLimit,
    hint: 'narrow with status/issueId filters',
  });
}

export async function pipelineRunsGetHandler(
  principal: McpPrincipal,
  input: z.infer<typeof pipelineRunsRunIdInputSchema>,
) {
  const run = await loadRunForPrincipal(principal, input.runId);

  const counts = await db
    .select({ status: jobs.status, count: sql<number>`count(*)::int` })
    .from(jobs)
    .where(eq(jobs.pipelineRunId, input.runId))
    .groupBy(jobs.status);

  const jobCounts: Record<string, number> = {};
  for (const r of counts) jobCounts[r.status] = Number(r.count);

  return { run, jobCounts };
}

export async function pipelineRunsPauseHandler(
  principal: McpPrincipal,
  input: z.infer<typeof pipelineRunsRunIdInputSchema>,
) {
  const loaded = await loadRunForPrincipal(principal, input.runId);
  await assertPrincipalIsWriter(principal, loaded.projectId);
  const run = await pausePipelineRun(input.runId);
  return { run };
}

export async function pipelineRunsResumeHandler(
  principal: McpPrincipal,
  input: z.infer<typeof pipelineRunsRunIdInputSchema>,
) {
  const loaded = await loadRunForPrincipal(principal, input.runId);
  await assertPrincipalIsWriter(principal, loaded.projectId);
  const run = await resumePipelineRun(input.runId);
  return { run };
}

export async function pipelineRunsCancelHandler(
  principal: McpPrincipal,
  input: z.infer<typeof pipelineRunsCancelInputSchema>,
) {
  const loaded = await loadRunForPrincipal(principal, input.runId);
  await assertPrincipalIsWriter(principal, loaded.projectId);
  return cancelPipelineRun(input.runId, {
    actorUserId: principalUserId(principal),
    ...(input.parkIssue !== undefined ? { parkIssue: input.parkIssue } : {}),
  });
}

function recordDeprecation(ctx: McpContext | { deprecations?: Set<string> }, toolName: string) {
  if (deprecationFor(toolName) && ctx.deprecations) ctx.deprecations.add(toolName);
}

export const forgePipelineRunsListTool: ContextScopedMcpToolFactory = (ctx) => ({
  name: 'forge_pipeline_runs.list',
  description:
    '[DEPRECATED — use forge_project_pipeline_runs (action=list)] List pipeline runs scoped to a project. Optional issueId/status filters. Ordered newest-first by started_at. ' +
    'EVERY list response carries `returned`, `limit` and `hasMore` — read `hasMore` before reporting a count as complete, because a list bound by your own limit is otherwise indistinguishable from a complete one. `truncated`/`truncatedBy` say which cap bit. ' +
    'Requires device owner to be a project member.',
  inputSchema: zodToMcpSchema(pipelineRunsListInputSchema),
  handler: async (args) => {
    recordDeprecation(ctx, 'forge_pipeline_runs.list');
    const input = pipelineRunsListInputSchema.parse(args);
    return pipelineRunsListHandler(ctx.device, input);
  },
});

export const forgePipelineRunsGetTool: ContextScopedMcpToolFactory = (ctx) => ({
  name: 'forge_pipeline_runs.get',
  description:
    '[DEPRECATED — use forge_project_pipeline_runs (action=get)] Fetch a single pipeline run plus a per-status job count breakdown. Requires the principal to be a member of the run’s project; PAT principals must additionally have the run’s project in their allowlist.',
  inputSchema: zodToMcpSchema(pipelineRunsRunIdInputSchema),
  handler: async (args) => {
    recordDeprecation(ctx, 'forge_pipeline_runs.get');
    const input = pipelineRunsRunIdInputSchema.parse(args);
    return pipelineRunsGetHandler(ctx.principal, input);
  },
});

export const forgePipelineRunsPauseTool: ContextScopedMcpToolFactory = (ctx) => ({
  name: 'forge_pipeline_runs.pause',
  description:
    '[DEPRECATED — use forge_project_pipeline_runs (action=pause)] Pause a running pipeline run. Idempotent on paused runs. Throws CONFLICT on terminal runs (completed/failed/cancelled). Requires project membership; PAT principals must additionally have the run’s project in their allowlist.',
  inputSchema: zodToMcpSchema(pipelineRunsRunIdInputSchema),
  handler: async (args) => {
    recordDeprecation(ctx, 'forge_pipeline_runs.pause');
    const input = pipelineRunsRunIdInputSchema.parse(args);
    return pipelineRunsPauseHandler(ctx.principal, input);
  },
});

export const forgePipelineRunsResumeTool: ContextScopedMcpToolFactory = (ctx) => ({
  name: 'forge_pipeline_runs.resume',
  description:
    '[DEPRECATED — use forge_project_pipeline_runs (action=resume)] Resume a paused pipeline run. Idempotent on already-running runs. Throws CONFLICT on terminal runs. Requires project membership; PAT principals must additionally have the run’s project in their allowlist.',
  inputSchema: zodToMcpSchema(pipelineRunsRunIdInputSchema),
  handler: async (args) => {
    recordDeprecation(ctx, 'forge_pipeline_runs.resume');
    const input = pipelineRunsRunIdInputSchema.parse(args);
    return pipelineRunsResumeHandler(ctx.principal, input);
  },
});

export const forgePipelineRunsCancelTool: ContextScopedMcpToolFactory = (ctx) => ({
  name: 'forge_pipeline_runs.cancel',
  description:
    '[DEPRECATED — use forge_project_pipeline_runs (action=cancel)] Cancel a pipeline run. Marks the run cancelled, cancels queued+dispatched jobs of the run, transitions linked agent_sessions to failed with reason=pipeline_cancelled, and broadcasts agent:abort to each affected device. Idempotent on already-cancelled runs. Throws CONFLICT on completed/failed. PAT principals must have the run’s project in their allowlist.',
  inputSchema: zodToMcpSchema(pipelineRunsCancelInputSchema),
  handler: async (args) => {
    recordDeprecation(ctx, 'forge_pipeline_runs.cancel');
    const input = pipelineRunsCancelInputSchema.parse(args);
    return pipelineRunsCancelHandler(ctx.principal, input);
  },
});
