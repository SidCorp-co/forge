/**
 * `forge_pm.write_decision` (Epic 3, ISS-19) — the MCP face of
 * `pm/decisions-service.ts`.
 *
 * ISS-145: handler body extracted into `pmWriteDecisionHandler` and
 * consumed by both the legacy shim factory below and the consolidated
 * `forge_project_pm` dispatcher.
 *
 * TODO ISS-145-followup: remove the legacy shim factory after the
 * deprecation window closes.
 */

import { z } from 'zod';
import type { Device } from '../../auth/deviceToken.js';
import { modelTiers } from '../../db/schema.js';
import { PM_DECISION_CAUSES, writePmDecision } from '../../pm/decisions-service.js';
import { deprecationFor } from '../deprecation.js';
import { type ContextScopedMcpToolFactory, type McpContext, zodToMcpSchema } from './lib.js';
import { assertPmActor } from './project-authz.js';

const escalateSchema = z
  .object({
    severity: z.enum(['low', 'medium', 'high', 'critical']),
    summary: z.string().min(1).max(2000),
    question: z.string().min(1).max(2000),
    options: z
      .array(z.object({ id: z.string().min(1).max(64), label: z.string().min(1).max(255) }))
      .min(1)
      .max(8),
    expiresAt: z.iso.datetime(),
  })
  .strict();

export const pmWriteDecisionInputSchema = z
  .object({
    projectId: z.uuid(),
    sessionId: z.uuid().optional(),
    cause: z.enum(PM_DECISION_CAUSES),
    eventRef: z.record(z.string(), z.unknown()).default({}),
    summary: z.string().min(1).max(4000),
    actions: z.array(z.record(z.string(), z.unknown())).default([]),
    confidence: z.number().min(0).max(1).optional(),
    modelTier: z.enum(modelTiers).optional(),
    tookMs: z.number().int().min(0).optional(),
    escalate: escalateSchema.optional(),
  })
  .strict();

export async function pmWriteDecisionHandler(
  device: Device,
  input: z.infer<typeof pmWriteDecisionInputSchema>,
) {
  await assertPmActor(device, input.projectId);
  return writePmDecision(input);
}

function recordDeprecation(ctx: McpContext, toolName: string) {
  if (deprecationFor(toolName) && ctx.deprecations) ctx.deprecations.add(toolName);
}

export const forgePmWriteDecisionTool: ContextScopedMcpToolFactory = (ctx) => ({
  name: 'forge_pm.write_decision',
  description:
    "[DEPRECATED — use forge_project_pm (action=write_decision)] Record a PM decision (cause + summary + actions) and queue it for memory indexing under source=decision. To escalate alongside the decision, pass an 'escalate' object — top-level 'summary' is the decision summary, 'escalate.summary' is the notification title shown to the project owner. Requires PM-actor capability.",
  inputSchema: zodToMcpSchema(pmWriteDecisionInputSchema),
  handler: async (args) => {
    recordDeprecation(ctx, 'forge_pm.write_decision');
    const input = pmWriteDecisionInputSchema.parse(args);
    return pmWriteDecisionHandler(ctx.device, input);
  },
});
