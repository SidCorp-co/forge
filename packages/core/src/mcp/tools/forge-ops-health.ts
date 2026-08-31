import { z } from 'zod';
import { readOpsHealth } from '../../health/service.js';
import {
  type ContextScopedMcpToolFactory,
  loadVisibleProjectIdsForPrincipal,
  zodToMcpSchema,
} from './lib.js';

const inputSchema = z
  .object({
    action: z.enum(['get']).optional(),
    staleJobThresholdSeconds: z.number().int().min(60).max(86_400).optional(),
  })
  .strict();

export const forgeOpsHealthTool: ContextScopedMcpToolFactory = (ctx) => ({
  name: 'forge_ops_health',
  description:
    'Health snapshot scoped to your projects (projects you own or are a member of). Returns `{ version, uptimeSeconds, db, queue, ws, runners: [{ id, name, projectId, status, lastSeenAt, inFlightCount }], projects: [{ id, slug, activeJobCount }], stuckJobs: [{ jobId, type, runnerId, dispatchedAt, ageSeconds }] }` — `runners`, `projects`, and `stuckJobs` are limited to your visible projects; `version`/`uptimeSeconds`/`db`/`queue`/`ws` are global status indicators. `staleJobThresholdSeconds` (60..86400, default 600) controls the stuckJobs cutoff.',
  inputSchema: zodToMcpSchema(inputSchema),
  handler: async (args) => {
    const input = inputSchema.parse(args);
    const visibleIds = await loadVisibleProjectIdsForPrincipal(ctx.principal);
    return readOpsHealth(visibleIds, input.staleJobThresholdSeconds ?? 600);
  },
});
