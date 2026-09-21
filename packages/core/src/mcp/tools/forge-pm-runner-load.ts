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
