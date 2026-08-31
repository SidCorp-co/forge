/**
 * `forge_pm.dispatch` (Epic 3, ISS-19) — PM agent enqueues a coder-skill
 * job (triage / plan / code / review / test / fix / release) for an issue.
 *
 * ISS-145: handler body extracted into `pmDispatchHandler` and consumed by
 * both the legacy shim factory below and the consolidated
 * `forge_project_pm` dispatcher.
 *
 * TODO ISS-145-followup: remove the legacy shim factory after the
 * deprecation window closes.
 */

import { z } from 'zod';
import type { Device } from '../../auth/deviceToken.js';
import { jobTypes, modelTiers } from '../../db/schema.js';
import { dispatchPmJob } from '../../pm/dispatch-service.js';
import { deprecationFor } from '../deprecation.js';
import { type ContextScopedMcpToolFactory, type McpContext, zodToMcpSchema } from './lib.js';
import { assertPmActor } from './project-authz.js';

export const pmDispatchInputSchema = z
  .object({
    projectId: z.uuid(),
    issueId: z.uuid(),
    jobType: z.enum(jobTypes),
    reason: z.string().min(1).max(2000),
    payload: z.record(z.string(), z.unknown()).optional(),
    modelTier: z.enum(modelTiers).optional(),
  })
  .strict();

export async function pmDispatchHandler(
  device: Device,
  input: z.infer<typeof pmDispatchInputSchema>,
) {
  await assertPmActor(device, input.projectId);
  return dispatchPmJob(input, device.ownerId);
}

function recordDeprecation(ctx: McpContext, toolName: string) {
  if (deprecationFor(toolName) && ctx.deprecations) ctx.deprecations.add(toolName);
}

export const forgePmDispatchTool: ContextScopedMcpToolFactory = (ctx) => ({
  name: 'forge_pm.dispatch',
  description:
    '[DEPRECATED — use forge_project_pm (action=dispatch)] PM agent enqueues a coder-skill job (triage/plan/code/review/test/fix/release) for an issue. Routes to the coder queue; idempotent against active duplicates via the jobs_active_unique index. Returns `pipelineRun: { id, status }` for the parent run so the caller can drive forge_pipeline_runs.* lifecycle controls. Requires PM-actor capability.',
  inputSchema: zodToMcpSchema(pmDispatchInputSchema),
  handler: async (args) => {
    recordDeprecation(ctx, 'forge_pm.dispatch');
    const input = pmDispatchInputSchema.parse(args);
    return pmDispatchHandler(ctx.device, input);
  },
});
