import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import {
  type IssueBranchOverride,
  resolveIssueBranches,
} from '../../branches/resolve.js';
import { db } from '../../db/client.js';
import { issues, projects } from '../../db/schema.js';
import { pipelineConfigPatchSchema } from '../../pipeline/pipeline-config-schema.js';
import {
  PipelineConfigError,
  updatePipelineConfig,
} from '../../pipeline/pipeline-config-service.js';
import {
  mergeStateContext,
  stateContextSchema,
} from '../../projects/state-context.js';
import {
  type ContextScopedMcpToolFactory,
  assertPrincipalIsAdmin,
  assertPrincipalIsMember,
  resolveProjectIdFromSlug,
  zodToMcpSchema,
} from './lib.js';

const inputSchema = z
  .object({
    action: z.enum(['get', 'update']).default('get'),
    projectId: z.uuid().optional(),
    issueId: z.uuid().optional(),
    pipelineConfig: pipelineConfigPatchSchema.optional(),
    stateContext: stateContextSchema.nullable().optional(),
  })
  .strict();

async function readProjectConfig(projectId: string) {
  const [row] = await db
    .select({
      id: projects.id,
      slug: projects.slug,
      name: projects.name,
      repoPath: projects.repoPath,
      baseBranch: projects.baseBranch,
      productionBranch: projects.productionBranch,
      agentConfig: projects.agentConfig,
    })
    .from(projects)
    .where(eq(projects.id, projectId))
    .limit(1);
  if (!row) throw new Error('NOT_FOUND: project not found');
  return row;
}

function formatBaseResponse(row: Awaited<ReturnType<typeof readProjectConfig>>) {
  const ac = (row.agentConfig as Record<string, unknown> | null) ?? {};
  return {
    project: {
      id: row.id,
      slug: row.slug,
      name: row.name,
    },
    config: {
      repoPath: row.repoPath,
      baseBranch: row.baseBranch,
      productionBranch: row.productionBranch,
      categories: (ac.categories as string[] | undefined) ?? [],
      pipelineConfig: (ac.pipelineConfig as Record<string, unknown> | undefined) ?? null,
      stateContext: (ac.stateContext as Record<string, unknown> | undefined) ?? null,
    },
  };
}

export const forgeConfigTool: ContextScopedMcpToolFactory = (ctx) => ({
  name: 'forge_config',
  description:
    "Read or write project configuration. Action `get` returns `config` with `repoPath`, `baseBranch`, `productionBranch` read DIRECTLY from the `projects` table columns (may be `null` when not configured — callers MUST NOT silently default to 'main'); plus `categories`, `pipelineConfig`, `stateContext` from `agent_config` JSON. When `issueId` is supplied, also returns a resolved `branchConfig` layering the issue override on top of the project defaults. Action `update` (admin-gated) merges a `pipelineConfig` patch with the same invariants as `PATCH /projects/:id/pipeline-config` and a `stateContext` patch (per-state merge — passing `{ code: {...} }` replaces only the `code` entry, other states untouched; pass `null` to wipe stateContext, or `{ code: null }` to remove one state). Errors surface as `BAD_REQUEST: <code>: <message>`.",
  inputSchema: zodToMcpSchema(inputSchema),
  handler: async (args) => {
    const input = inputSchema.parse(args);

    if (input.action === 'update') {
      if (!input.projectId) {
        throw new Error('BAD_REQUEST: projectId is required for action=update');
      }
      await assertPrincipalIsAdmin(ctx.principal, input.projectId);
      if (input.pipelineConfig) {
        try {
          await updatePipelineConfig({
            projectId: input.projectId,
            patch: input.pipelineConfig,
          });
        } catch (err) {
          if (err instanceof PipelineConfigError) {
            if (err.code === 'PROJECT_NOT_FOUND') {
              throw new Error('NOT_FOUND: project not found');
            }
            const payload = JSON.stringify({ code: err.code, message: err.message, details: err.details });
            throw new Error(`BAD_REQUEST: ${err.code}: ${payload}`);
          }
          throw err;
        }
      }
      if (input.stateContext !== undefined) {
        const [row] = await db
          .select({ agentConfig: projects.agentConfig })
          .from(projects)
          .where(eq(projects.id, input.projectId))
          .limit(1);
        if (!row) throw new Error('NOT_FOUND: project not found');
        const currentAc = (row.agentConfig ?? {}) as Record<string, unknown>;
        const mergedSc = mergeStateContext(currentAc.stateContext, input.stateContext);
        const nextAc: Record<string, unknown> =
          mergedSc === null
            ? Object.fromEntries(
                Object.entries(currentAc).filter(([k]) => k !== 'stateContext'),
              )
            : { ...currentAc, stateContext: mergedSc };
        await db.update(projects).set({ agentConfig: nextAc }).where(eq(projects.id, input.projectId));
      }
      const row = await readProjectConfig(input.projectId);
      return formatBaseResponse(row);
    }

    const projectId = input.projectId ?? (await resolveProjectIdFromSlug(ctx.projectSlug));
    await assertPrincipalIsMember(ctx.principal, projectId);

    const row = await readProjectConfig(projectId);
    const baseResponse = formatBaseResponse(row);

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
