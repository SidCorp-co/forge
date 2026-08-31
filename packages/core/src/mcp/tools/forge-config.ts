import { z } from 'zod';
import { type IssueBranchOverride, resolveIssueBranches } from '../../branches/resolve.js';
import { env } from '../../config/env.js';
import { deleteKnowledgeEntry, upsertKnowledgeEntry } from '../../knowledge/service.js';
import { logger } from '../../logger.js';
import { pipelineConfigPatchSchema } from '../../pipeline/pipeline-config-schema.js';
import {
  PipelineConfigError,
  updatePipelineConfig,
} from '../../pipeline/pipeline-config-service.js';
import {
  mergePluginDesignations,
  pluginDesignationsPatchSchema,
  readPluginDesignations,
} from '../../plugins/designation.js';
import { patchAgentConfigKey, readAgentConfig } from '../../projects/agent-config.js';
import {
  mergeProjectFacts,
  mergeProjectFactsConfig,
  projectFactsConfigPatchSchema,
  projectFactsPatchSchema,
  RESERVED_PROJECT_FACT_KEYS,
} from '../../projects/project-facts.js';
import { readIssueSessionContext, readProjectWithConfig } from '../../projects/service.js';
import { mergeStateContext, stateContextSchema } from '../../projects/state-context.js';
import {
  assertPrincipalIsAdmin,
  assertPrincipalIsMember,
  type ContextScopedMcpToolFactory,
  resolveEffectiveProjectId,
  zodToMcpSchema,
} from './lib.js';

const inputSchema = z
  .object({
    action: z.enum(['get', 'update']).default('get'),
    projectId: z.uuid().optional(),
    issueId: z.uuid().optional(),
    pipelineConfig: pipelineConfigPatchSchema.optional(),
    stateContext: stateContextSchema.nullable().optional(),
    projectFacts: projectFactsPatchSchema,
    projectFactsConfig: projectFactsConfigPatchSchema,
    plugins: pluginDesignationsPatchSchema.optional(),
  })
  .strict();

async function readProjectConfig(projectId: string) {
  const row = await readProjectWithConfig(projectId);
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
      projectFacts: (ac.projectFacts as Record<string, string> | undefined) ?? {},
      projectFactsConfig:
        (ac.projectFactsConfig as Record<string, { alwaysInject?: boolean }> | undefined) ?? {},
      plugins: readPluginDesignations(ac),
    },
  };
}

export const forgeConfigTool: ContextScopedMcpToolFactory = (ctx) => ({
  name: 'forge_config',
  description:
    "Read or write project configuration. Action `get` returns `config` with `repoPath`, `baseBranch`, `productionBranch` read DIRECTLY from the `projects` table columns (may be `null` when not configured — callers MUST NOT silently default to 'main'); plus `categories`, `pipelineConfig`, `stateContext`, `projectFacts` from `agent_config` JSON. When `issueId` is supplied, also returns a resolved `branchConfig` layering the issue override on top of the project defaults. Action `update` (admin-gated) merges a `pipelineConfig` patch with the same invariants as `PATCH /projects/:id/pipeline-config`, a `stateContext` patch (per-state merge — passing `{ code: {...} }` replaces only the `code` entry, other states untouched; pass `null` to wipe stateContext, or `{ code: null }` to remove one state), and a `projectFacts` patch (kebab-case key→text map referenced from skill bodies as `{{project:<key>}}`; per-key merge, value `null` removes a key, whole-map `null` wipes it; reserved keys base-branch/production-branch/repo-path/test-urls/test-creds are derived and ignored here; NEVER store secrets — they would sync to disk), and a `projectFactsConfig` patch (per-key `{ alwaysInject }` map — when a fact key is flagged `alwaysInject: true` its FULL body is injected verbatim into every agent system prompt for this project, like a mandatory rule, instead of the default fetch-on-demand pointer; same per-key merge semantics, value `null` removes a key's config, whole-map `null` wipes it; capped at a char budget that warns on overflow), and a `plugins` list designating the Claude Code plugins this project's runners must install (`[{marketplace, name, pinnedRef?, autoUpdate?}]`; marketplace is an `owner/repo`, name is kebab-case, pinnedRef is a commit SHA). UNLIKE the patches above, `plugins` REPLACES the whole list — GET first, send the complete list, `null` clears it. Designation is per-project but install is per-DEVICE: a device resolves the union of every project it is bound to via `GET /api/devices/me/plugins`, so a plugin designated by one project is installed for all of them; per-project opt-out belongs in that repo's own `.claude/settings.json` `enabledPlugins`. Errors surface as `BAD_REQUEST: <code>: <message>`.",
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
            const payload = JSON.stringify({
              code: err.code,
              message: err.message,
              details: err.details,
            });
            throw new Error(`BAD_REQUEST: ${err.code}: ${payload}`);
          }
          throw err;
        }
      }
      if (input.stateContext !== undefined) {
        await patchAgentConfigKey(input.projectId, 'stateContext', (current) =>
          mergeStateContext(current.stateContext, input.stateContext),
        );
      }
      if (input.projectFacts !== undefined) {
        await patchAgentConfigKey(input.projectId, 'projectFacts', (current) =>
          mergeProjectFacts(current.projectFacts, input.projectFacts),
        );
      }
      if (input.plugins !== undefined) {
        const plugins = input.plugins;
        await patchAgentConfigKey(input.projectId, 'plugins', () =>
          mergePluginDesignations(plugins),
        );
      }
      // AC6: write-through to knowledge_entries when the flag is ON.
      if (
        env.KNOWLEDGE_INJECTION_ENABLED &&
        input.projectFacts !== undefined &&
        input.projectFacts !== null
      ) {
        logger.warn(
          { projectId: input.projectId },
          'forge_config projectFacts is deprecated; writing through to knowledge_entries',
        );
        const factsAc = (await readAgentConfig(input.projectId)) ?? {};
        const factsConfig =
          (factsAc.projectFactsConfig as Record<string, { alwaysInject?: boolean }> | undefined) ??
          {};
        const factsMap = (factsAc.projectFacts as Record<string, string> | undefined) ?? {};
        const reserved = new Set<string>(RESERVED_PROJECT_FACT_KEYS);
        const patchEntries = Object.entries(input.projectFacts as Record<string, string | null>);
        for (let i = 0; i < patchEntries.length; i++) {
          const [key, value] = patchEntries[i] as [string, string | null];
          if (reserved.has(key)) continue;
          if (value === null) {
            await deleteKnowledgeEntry(input.projectId, key).catch(() => undefined);
          } else {
            const alwaysInject = factsConfig[key]?.alwaysInject === true;
            await upsertKnowledgeEntry({
              projectId: input.projectId,
              slug: key,
              title: key,
              body: value,
              kind: 'guide',
              injection: alwaysInject ? 'always' : 'on_demand',
              confidence: 'verified',
              authoredBy: 'human',
              orderIndex: Object.keys(factsMap).indexOf(key),
            }).catch((err: Error) => {
              logger.warn(
                { err: err.message, key },
                'forge_config: knowledge write-through failed for key',
              );
            });
          }
        }
      }
      if (input.projectFactsConfig !== undefined) {
        await patchAgentConfigKey(input.projectId, 'projectFactsConfig', (current) =>
          mergeProjectFactsConfig(current.projectFactsConfig, input.projectFactsConfig),
        );
      }
      const row = await readProjectConfig(input.projectId);
      return formatBaseResponse(row);
    }

    const projectId = await resolveEffectiveProjectId(ctx, input.projectId);
    await assertPrincipalIsMember(ctx.principal, projectId);

    const row = await readProjectConfig(projectId);
    const baseResponse = formatBaseResponse(row);

    if (!input.issueId) return baseResponse;

    const issueRow = await readIssueSessionContext(input.issueId, projectId);
    if (!issueRow) throw new Error('NOT_FOUND: issue not found in project');

    // PR-C will add a real `issues.metadata` jsonb column; until then, accept
    // the override from `metadata` if present and fall back to `sessionContext`.
    const issueLike = issueRow as {
      metadata?: { branchConfig?: unknown } | null;
      sessionContext: unknown;
    };
    const metadataOverride =
      (
        issueLike.metadata as {
          branchConfig?: IssueBranchOverride | null;
        } | null
      )?.branchConfig ?? null;
    const sessionContextOverride =
      (
        issueLike.sessionContext as {
          branchConfig?: IssueBranchOverride | null;
        } | null
      )?.branchConfig ?? null;
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
