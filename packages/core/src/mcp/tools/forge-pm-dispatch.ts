/**
 * `forge_pm.dispatch` (Epic 3, ISS-19) — PM agent enqueues a coder-skill
 * job (triage / plan / code / review / test / fix / release) for an issue.
 *
 * ISS-145: handler body extracted into `pmDispatchHandler` and consumed by
 * both the legacy shim factory below and the consolidated
 * `forge_project_pm` dispatcher.
 */

import { z } from 'zod';
import { jobTypes, modelTiers } from '../../db/schema.js';
import type { McpPrincipal } from '../../middleware/require-pat.js';
import { dispatchPmJob } from '../../pm/dispatch-service.js';

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
  principal: McpPrincipal,
  input: z.infer<typeof pmDispatchInputSchema>,
) {
  return dispatchPmJob(input, principal.userId);
}
