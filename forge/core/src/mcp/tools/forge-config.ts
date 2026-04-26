import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../../db/client.js';
import { projects } from '../../db/schema.js';
import {
  type ContextScopedMcpToolFactory,
  assertDeviceOwnerIsMember,
  resolveProjectIdFromSlug,
  zodToMcpSchema,
} from './lib.js';

const inputSchema = z
  .object({
    action: z.literal('get'),
    projectId: z.uuid().optional(),
  })
  .strict();

export const forgeConfigTool: ContextScopedMcpToolFactory = (ctx) => ({
  name: 'forge_config',
  description:
    'Read project configuration (agentConfig: repoPath, baseBranch, productionBranch, categories, pipelineConfig). Action: get. Project resolved from `projectId` arg or `X-Forge-Project-Slug` header.',
  inputSchema: zodToMcpSchema(inputSchema),
  handler: async (args) => {
    const input = inputSchema.parse(args);
    const projectId = input.projectId ?? (await resolveProjectIdFromSlug(ctx.projectSlug));
    await assertDeviceOwnerIsMember(ctx.device, projectId);

    const [row] = await db
      .select({
        id: projects.id,
        slug: projects.slug,
        name: projects.name,
        agentConfig: projects.agentConfig,
      })
      .from(projects)
      .where(eq(projects.id, projectId))
      .limit(1);

    if (!row) throw new Error('NOT_FOUND: project not found');

    const ac = (row.agentConfig as Record<string, unknown> | null) ?? {};
    return {
      project: {
        id: row.id,
        slug: row.slug,
        name: row.name,
      },
      config: {
        repoPath: (ac.repoPath as string | undefined) ?? null,
        baseBranch: (ac.baseBranch as string | undefined) ?? 'main',
        productionBranch: (ac.productionBranch as string | undefined) ?? 'main',
        categories: (ac.categories as string[] | undefined) ?? [],
        pipelineConfig: (ac.pipelineConfig as Record<string, unknown> | undefined) ?? null,
        activeDeviceId: (ac.activeDeviceId as string | undefined) ?? null,
      },
    };
  },
});
