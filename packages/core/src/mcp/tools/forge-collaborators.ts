import { z } from 'zod';
import { listCollaborators } from '../../projects/collaborators-service.js';
import {
  type ContextScopedMcpToolFactory,
  loadVisibleProjectIdsForPrincipal,
  zodToMcpSchema,
} from './lib.js';

const inputSchema = z
  .object({
    action: z.enum(['list']),
    limit: z.number().int().min(1).max(200).optional(),
    offset: z.number().int().min(0).optional(),
    search: z.string().trim().min(1).max(200).optional(),
  })
  .strict();

export const forgeCollaboratorsTool: ContextScopedMcpToolFactory = (ctx) => ({
  name: 'forge_collaborators',
  description:
    'List the collaborators across your projects (projects you own or are a member of) with a membership matrix scoped to those projects. Read-only. Action: `list` (optional `search` matches email prefix; paginated). Each user includes `memberships: [{ projectId, projectSlug, role }]` limited to your visible projects. Never returns passwordHash or any auth secret.',
  inputSchema: zodToMcpSchema(inputSchema),
  handler: async (args) => {
    const input = inputSchema.parse(args);
    const limit = input.limit ?? 50;
    const offset = input.offset ?? 0;

    const visibleProjectIds = await loadVisibleProjectIdsForPrincipal(ctx.principal);
    return listCollaborators({ visibleProjectIds, limit, offset, search: input.search });
  },
});
