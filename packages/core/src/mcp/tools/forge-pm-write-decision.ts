/**
 * `forge_pm.write_decision` (Epic 3, ISS-19) — the MCP face of
 * `pm/decisions-service.ts`.
 *
 * ISS-145: handler body extracted into `pmWriteDecisionHandler` and
 * consumed by both the legacy shim factory below and the consolidated
 * `forge_project_pm` dispatcher.
 */

import { z } from 'zod';
import { modelTiers } from '../../db/schema.js';
import type { McpPrincipal } from '../../middleware/require-pat.js';
import { PM_DECISION_CAUSES, writePmDecision } from '../../pm/decisions-service.js';
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
  principal: McpPrincipal,
  input: z.infer<typeof pmWriteDecisionInputSchema>,
) {
  await assertPmActor(principal);
  return writePmDecision(input);
}
