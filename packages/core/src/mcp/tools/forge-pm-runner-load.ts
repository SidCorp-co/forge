/**
 * `forge_pm.runner_load` (Epic 3, ISS-19) — the MCP face of
 * `pm/runner-load-service.ts`: per-runner status + in-flight counter, so the
 * PM agent can decide where (or whether) to dispatch work.
 *
 * ISS-145: handler body extracted into `pmRunnerLoadHandler` and consumed
 * by both the legacy shim factory below and the consolidated
 * `forge_project_pm` dispatcher.
 *
 * TODO ISS-145-followup: remove the legacy shim factory after the
 * deprecation window closes.
 */

import { z } from 'zod';
import type { Device } from '../../auth/deviceToken.js';
import { readRunnerLoad } from '../../pm/runner-load-service.js';
import { deprecationFor } from '../deprecation.js';
import { type ContextScopedMcpToolFactory, type McpContext, zodToMcpSchema } from './lib.js';
import { assertDeviceOwnerIsMember } from './project-authz.js';

export const pmRunnerLoadInputSchema = z.object({ projectId: z.uuid() }).strict();

export async function pmRunnerLoadHandler(
  device: Device,
  input: z.infer<typeof pmRunnerLoadInputSchema>,
) {
  await assertDeviceOwnerIsMember(device, input.projectId);

  const out = await readRunnerLoad(input.projectId);

  return { runners: out };
}

function recordDeprecation(ctx: McpContext, toolName: string) {
  if (deprecationFor(toolName) && ctx.deprecations) ctx.deprecations.add(toolName);
}

export const forgePmRunnerLoadTool: ContextScopedMcpToolFactory = (ctx) => ({
  name: 'forge_pm.runner_load',
  description:
    '[DEPRECATED — use forge_project_pm (action=runner_load)] Per-runner status + in-flight job counter for a project. Read-only; requires project membership.',
  inputSchema: zodToMcpSchema(pmRunnerLoadInputSchema),
  handler: async (args) => {
    recordDeprecation(ctx, 'forge_pm.runner_load');
    const input = pmRunnerLoadInputSchema.parse(args);
    return pmRunnerLoadHandler(ctx.device, input);
  },
});
