/**
 * ISS-102 / ISS-145 — the pipeline-run actions, and the one legacy tool name
 * still answering for them.
 *
 * The five action functions (list/get/pause/resume/cancel) carry the logic —
 * auth check, db read, control call — and `forge_project_pipeline_runs`
 * dispatches into all five. Only `forge_pipeline_runs.get` is still
 * registered under its own name, because `forge-skill-audit` calls it that
 * way; it emits `X-MCP-Deprecation` via `handler.ts`. The other four shim
 * factories were deleted once nothing named them.
 */

import { z } from 'zod';
import type { Device } from '../../auth/deviceToken.js';
import { pipelineRunStatuses } from '../../db/schema.js';
import type { McpPrincipal } from '../../middleware/require-pat-or-device.js';
import { countRunJobsByStatus, listPipelineRuns, readPipelineRun } from '../../pipeline/runs.js';
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
  const row = await readPipelineRun(runId);
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
  const rows = await listPipelineRuns({
    projectId: input.projectId,
    issueId: input.issueId,
    status: input.status,
    limit: overfetch(runsLimit),
  });

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

  const jobCounts = await countRunJobsByStatus(input.runId);
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
