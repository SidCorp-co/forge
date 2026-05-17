/**
 * ISS-102 — MCP surface for pipeline_run lifecycle controls.
 *
 * Five tools mirror the REST endpoints under `/api/pipeline-runs/*` so AI
 * agents (PM, runner-side workflows) can pause / resume / cancel a
 * pipeline_run alongside the REST callers in the UI. Tool names use the
 * `forge_pipeline_runs.<action>` shape to match the existing
 * `forge_agent_sessions.list/.get` and `forge_jobs.list/.get/.events`
 * convention.
 *
 * The list tool stays device-scoped because the server-level allowlist check
 * already enforces PAT `projectIds` on the explicit `projectId` arg. The
 * runId-resolved get/pause/resume/cancel tools are context-scoped so they
 * route through `assertPrincipalIsMember` and enforce the PAT allowlist
 * after the run lookup (ISS-150 review #1 re-review).
 */

import { type SQL, and, desc, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../../db/client.js';
import { jobs, pipelineRunStatuses, pipelineRuns } from '../../db/schema.js';
import type { McpPrincipal } from '../../middleware/require-pat-or-device.js';
import {
  cancelPipelineRun,
  pausePipelineRun,
  resumePipelineRun,
} from '../../pipeline/runs-control.js';
import {
  type ContextScopedMcpToolFactory,
  type DeviceScopedMcpToolFactory,
  assertDeviceOwnerIsMember,
  assertPrincipalIsMember,
  zodToMcpSchema,
} from './lib.js';

const listInputSchema = z
  .object({
    projectId: z.uuid(),
    issueId: z.uuid().optional(),
    status: z.enum(pipelineRunStatuses).optional(),
    limit: z.number().int().min(1).max(200).optional(),
  })
  .strict();

const runIdInputSchema = z.object({ runId: z.uuid() }).strict();

async function loadRunForPrincipal(principal: McpPrincipal, runId: string) {
  const [row] = await db
    .select()
    .from(pipelineRuns)
    .where(eq(pipelineRuns.id, runId))
    .limit(1);
  if (!row) throw new Error('NOT_FOUND: pipeline run not found');
  await assertPrincipalIsMember(principal, row.projectId);
  return row;
}

export const forgePipelineRunsListTool: DeviceScopedMcpToolFactory = (device) => ({
  name: 'forge_pipeline_runs.list',
  description:
    'List pipeline runs scoped to a project. Optional issueId/status filters. Ordered newest-first by started_at. Requires device owner to be a project member.',
  inputSchema: zodToMcpSchema(listInputSchema),
  handler: async (args) => {
    const { projectId, issueId, status, limit } = listInputSchema.parse(args);
    await assertDeviceOwnerIsMember(device, projectId);

    const conds: SQL[] = [eq(pipelineRuns.projectId, projectId)];
    if (issueId) conds.push(eq(pipelineRuns.issueId, issueId));
    if (status) conds.push(eq(pipelineRuns.status, status));

    const rows = await db
      .select()
      .from(pipelineRuns)
      .where(and(...conds))
      .orderBy(desc(pipelineRuns.startedAt))
      .limit(limit ?? 50);

    return { runs: rows };
  },
});

export const forgePipelineRunsGetTool: ContextScopedMcpToolFactory = ({ principal }) => ({
  name: 'forge_pipeline_runs.get',
  description:
    'Fetch a single pipeline run plus a per-status job count breakdown. Requires the principal to be a member of the run’s project; PAT principals must additionally have the run’s project in their allowlist.',
  inputSchema: zodToMcpSchema(runIdInputSchema),
  handler: async (args) => {
    const { runId } = runIdInputSchema.parse(args);
    const run = await loadRunForPrincipal(principal, runId);

    const counts = await db
      .select({ status: jobs.status, count: sql<number>`count(*)::int` })
      .from(jobs)
      .where(eq(jobs.pipelineRunId, runId))
      .groupBy(jobs.status);

    const jobCounts: Record<string, number> = {};
    for (const r of counts) jobCounts[r.status] = Number(r.count);

    return { run, jobCounts };
  },
});

export const forgePipelineRunsPauseTool: ContextScopedMcpToolFactory = ({ principal }) => ({
  name: 'forge_pipeline_runs.pause',
  description:
    'Pause a running pipeline run. Idempotent on paused runs. Throws CONFLICT on terminal runs (completed/failed/cancelled). Requires project membership; PAT principals must additionally have the run’s project in their allowlist.',
  inputSchema: zodToMcpSchema(runIdInputSchema),
  handler: async (args) => {
    const { runId } = runIdInputSchema.parse(args);
    await loadRunForPrincipal(principal, runId);
    const run = await pausePipelineRun(runId);
    return { run };
  },
});

export const forgePipelineRunsResumeTool: ContextScopedMcpToolFactory = ({ principal }) => ({
  name: 'forge_pipeline_runs.resume',
  description:
    'Resume a paused pipeline run. Idempotent on already-running runs. Throws CONFLICT on terminal runs. Requires project membership; PAT principals must additionally have the run’s project in their allowlist.',
  inputSchema: zodToMcpSchema(runIdInputSchema),
  handler: async (args) => {
    const { runId } = runIdInputSchema.parse(args);
    await loadRunForPrincipal(principal, runId);
    const run = await resumePipelineRun(runId);
    return { run };
  },
});

export const forgePipelineRunsCancelTool: ContextScopedMcpToolFactory = ({ principal }) => ({
  name: 'forge_pipeline_runs.cancel',
  description:
    'Cancel a pipeline run. Marks the run cancelled, cancels queued+dispatched jobs of the run, transitions linked agent_sessions to failed with reason=pipeline_cancelled, and broadcasts agent:abort to each affected device. Idempotent on already-cancelled runs. Throws CONFLICT on completed/failed. PAT principals must have the run’s project in their allowlist.',
  inputSchema: zodToMcpSchema(runIdInputSchema),
  handler: async (args) => {
    const { runId } = runIdInputSchema.parse(args);
    await loadRunForPrincipal(principal, runId);
    const result = await cancelPipelineRun(runId);
    return result;
  },
});
