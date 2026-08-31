/**
 * `forge_pm.graph` (Epic 3, ISS-19) — dependency / parent-child graph that
 * the PM agent inspects when reasoning about blockers, parallelism, and
 * epic decomposition. Every edge comes from `issue_dependencies`
 * (kind = blocks / relates / duplicates / parent).
 *
 * - `rootIssueId` omitted → return the whole project graph, capped at
 *   `MAX_NODES`. Returns `truncated:true` + `remainingNodes:N` when the
 *   project has more than `MAX_NODES` issues (ISS-145).
 * - `rootIssueId` set → BFS to `depth` (default 2, max 5). Undirected over
 *   both edge tables. Cycles are guarded by a visited set.
 *
 * ISS-145: handler body extracted into `pmGraphHandler` and consumed by
 * both the legacy shim factory below and the consolidated
 * `forge_project_pm` dispatcher.
 *
 * TODO ISS-145-followup: remove the legacy shim factory after the
 * deprecation window closes.
 */

import { z } from 'zod';
import type { Device } from '../../auth/deviceToken.js';
import { PM_GRAPH_DEFAULT_DEPTH, PM_GRAPH_MAX_DEPTH, readPmGraph } from '../../pm/graph-service.js';
import { deprecationFor } from '../deprecation.js';
import { type ContextScopedMcpToolFactory, type McpContext, zodToMcpSchema } from './lib.js';
import { assertDeviceOwnerIsMember } from './project-authz.js';

export const pmGraphInputSchema = z
  .object({
    projectId: z.uuid(),
    rootIssueId: z.uuid().optional(),
    depth: z.number().int().min(1).max(PM_GRAPH_MAX_DEPTH).default(PM_GRAPH_DEFAULT_DEPTH),
  })
  .strict();

export async function pmGraphHandler(device: Device, input: z.infer<typeof pmGraphInputSchema>) {
  await assertDeviceOwnerIsMember(device, input.projectId);
  return readPmGraph(input);
}

function recordDeprecation(ctx: McpContext, toolName: string) {
  if (deprecationFor(toolName) && ctx.deprecations) ctx.deprecations.add(toolName);
}

export const forgePmGraphTool: ContextScopedMcpToolFactory = (ctx) => ({
  name: 'forge_pm.graph',
  description:
    '[DEPRECATED — use forge_project_pm (action=graph)] Dependency + parent graph for a project. Without rootIssueId returns the full graph (capped at 200 nodes; `truncated:true` + `remainingNodes:N` when the project exceeds the cap). With rootIssueId runs BFS to `depth` (default 2, max 5). Read-only; requires project membership.',
  inputSchema: zodToMcpSchema(pmGraphInputSchema),
  handler: async (args) => {
    recordDeprecation(ctx, 'forge_pm.graph');
    const input = pmGraphInputSchema.parse(args);
    return pmGraphHandler(ctx.device, input);
  },
});
