/**
 * `forge_pm.runner_load` (Epic 3, ISS-19) — the MCP face of
 * `pm/runner-load-service.ts`: per-runner status + in-flight counter, so the
 * PM agent can decide where (or whether) to dispatch work.
 *
 * ISS-145: handler body extracted into `pmRunnerLoadHandler` and consumed
 * by both the legacy shim factory below and the consolidated
 * `forge_project_pm` dispatcher.
 */

import { z } from 'zod';
import type { McpPrincipal } from '../../middleware/require-pat.js';
import { readRunnerLoad } from '../../pm/runner-load-service.js';
import { assertPrincipalIsMember } from './lib.js';

export const pmRunnerLoadInputSchema = z.object({ projectId: z.uuid() }).strict();

export async function pmRunnerLoadHandler(
  principal: McpPrincipal,
  input: z.infer<typeof pmRunnerLoadInputSchema>,
) {
  await assertPrincipalIsMember(principal, input.projectId);

  const out = await readRunnerLoad(input.projectId);

  return { runners: out };
}
