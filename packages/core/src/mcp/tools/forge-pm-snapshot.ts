/**
 * `forge_pm.snapshot` (Epic 3, ISS-19) — the MCP face of
 * `pm/snapshot-service.ts`, which owns the digest itself.
 *
 * ISS-145: handler body extracted into `pmSnapshotHandler` and consumed by
 * both the legacy shim factory below and the consolidated
 * `forge_project_pm` dispatcher.
 *
 * TODO ISS-145-followup: remove the legacy shim factory after the
 * deprecation window closes.
 */

import { z } from 'zod';
import type { Device } from '../../auth/deviceToken.js';
import { readPmSnapshot } from '../../pm/snapshot-service.js';
import { deprecationFor } from '../deprecation.js';
import { type ContextScopedMcpToolFactory, type McpContext, zodToMcpSchema } from './lib.js';
import { assertDeviceOwnerIsMember } from './project-authz.js';

export const pmSnapshotInputSchema = z.object({ projectId: z.uuid() }).strict();

export async function pmSnapshotHandler(
  device: Device,
  input: z.infer<typeof pmSnapshotInputSchema>,
) {
  await assertDeviceOwnerIsMember(device, input.projectId);
  return readPmSnapshot(input.projectId);
}

function recordDeprecation(ctx: McpContext, toolName: string) {
  if (deprecationFor(toolName) && ctx.deprecations) ctx.deprecations.add(toolName);
}

export const forgePmSnapshotTool: ContextScopedMcpToolFactory = (ctx) => ({
  name: 'forge_pm.snapshot',
  description:
    '[DEPRECATED — use forge_project_pm (action=snapshot)] Compact project-state digest for the PM agent: counts by status, active jobs, stalled issues, queued count, recent failures, runner health. Read-only; requires project membership.',
  inputSchema: zodToMcpSchema(pmSnapshotInputSchema),
  handler: async (args) => {
    recordDeprecation(ctx, 'forge_pm.snapshot');
    const input = pmSnapshotInputSchema.parse(args);
    return pmSnapshotHandler(ctx.device, input);
  },
});
