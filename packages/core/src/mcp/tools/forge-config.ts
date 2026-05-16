import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import {
  type IssueBranchOverride,
  resolveIssueBranches,
} from '../../branches/resolve.js';
import { db } from '../../db/client.js';
import { issues, projects } from '../../db/schema.js';
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
    issueId: z.uuid().optional(),
  })
  .strict();

export const forgeConfigTool: ContextScopedMcpToolFactory = (ctx) => ({
  name: 'forge_config',
  description:
    'Read project configuration (agentConfig: repoPath, baseBranch, productionBranch, categories, pipelineConfig). Action: get. Project resolved from `projectId` arg or `X-Forge-Project-Slug` header. When `issueId` is supplied, the response also includes a resolved `branchConfig` (baseBranch, targetBranch, prodBranch) layering the issue override on top of the project default.',
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
        baseBranch: projects.baseBranch,
        productionBranch: projects.productionBranch,
        agentConfig: projects.agentConfig,
      })
      .from(projects)
      .where(eq(projects.id, projectId))
      .limit(1);

    if (!row) throw new Error('NOT_FOUND: project not found');

    const ac = (row.agentConfig as Record<string, unknown> | null) ?? {};
    const baseResponse = {
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

    if (!input.issueId) return baseResponse;

    const [issueRow] = await db
      .select({
        id: issues.id,
        sessionContext: issues.sessionContext,
      })
      .from(issues)
      .where(and(eq(issues.id, input.issueId), eq(issues.projectId, projectId)))
      .limit(1);
    if (!issueRow) throw new Error('NOT_FOUND: issue not found in project');

    // PR-C will add a real `issues.metadata` jsonb column; until then, accept
    // the override from `metadata` if present and fall back to `sessionContext`.
    const issueLike = issueRow as {
      metadata?: { branchConfig?: unknown } | null;
      sessionContext: unknown;
    };
    const metadataOverride =
      (issueLike.metadata as { branchConfig?: IssueBranchOverride | null } | null)?.branchConfig ??
      null;
    const sessionContextOverride =
      (issueLike.sessionContext as { branchConfig?: IssueBranchOverride | null } | null)
        ?.branchConfig ?? null;
    const branchConfigOverride: IssueBranchOverride | null =
      metadataOverride ?? sessionContextOverride;

    const branchConfig = resolveIssueBranches(
      { metadata: { branchConfig: branchConfigOverride } },
      { baseBranch: row.baseBranch, productionBranch: row.productionBranch },
    );

    return {
      ...baseResponse,
      config: {
        ...baseResponse.config,
        branchConfig,
      },
    };
  },
});
