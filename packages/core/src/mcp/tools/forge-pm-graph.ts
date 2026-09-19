import { z } from 'zod';
import type { McpPrincipal } from '../../middleware/require-pat.js';
import { PM_GRAPH_DEFAULT_DEPTH, PM_GRAPH_MAX_DEPTH, readPmGraph } from '../../pm/graph-service.js';
import { assertPrincipalIsMember } from './lib.js';

export const pmGraphInputSchema = z
  .object({
    projectId: z.uuid(),
    rootIssueId: z.uuid().optional(),
    depth: z.number().int().min(1).max(PM_GRAPH_MAX_DEPTH).default(PM_GRAPH_DEFAULT_DEPTH),
  })
  .strict();

export async function pmGraphHandler(
  principal: McpPrincipal,
  input: z.infer<typeof pmGraphInputSchema>,
) {
  await assertPrincipalIsMember(principal, input.projectId);
  return readPmGraph(input);
}
