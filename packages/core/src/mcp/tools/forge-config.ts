import { z } from 'zod';
import { extractIssueBranchOverride, resolveIssueBranches } from '../../branches/resolve.js';
import { env } from '../../config/env.js';
import { deleteKnowledgeEntry, upsertKnowledgeEntries } from '../../knowledge/service.js';
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
import {
  patchAgentConfigKey,
  RETIRED_STATE_CONTEXT_MESSAGE,
  readAgentConfig,
} from '../../projects/agent-config.js';
import {
  ALWAYS_INJECT_ENFORCEMENT_NOTE,
  ALWAYS_INJECT_GUARANTEE_NOTE,
  RETIRED_PROJECT_FACTS_CONFIG_MESSAGE,
  RETIRED_PROJECT_FACTS_MESSAGE,
} from '../../projects/project-facts.js';
import { readableLiveBranch } from '../../projects/release-model.js';
import { readIssueBranchInputs, readProjectWithConfig } from '../../projects/service.js';
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
      liveBranch: readableLiveBranch(row),
      releaseModel: row.releaseModel,
      releaseStrategy: row.releaseStrategy,
      categories: (ac.categories as string[] | undefined) ?? [],
      pipelineConfig: (ac.pipelineConfig as Record<string, unknown> | undefined) ?? null,
      plugins: readPluginDesignations(ac),
    },
  };
}

export const forgeConfigTool: ContextScopedMcpToolFactory = (ctx) => ({
  name: 'forge_config',
  // cm:edge contract -> packages/core/src/projects/project-facts.ts — the description ENDS with both notes, appended rather than paraphrased; a rewrite that drops them puts the enforcement promise back
  description:
    "Read or write project configuration. Action `get` returns `config` with `repoPath`, `baseBranch`, `liveBranch`, `releaseModel` and `releaseStrategy` read DIRECTLY from the `projects` table columns. `releaseModel` is `none` (no release step — `closed` means closed), `promote` (the release moves code from `baseBranch` to `liveBranch`, by `releaseStrategy`) or `publish` (the ref does not change; the release is an act on a live deploy binding). `liveBranch` is non-null only under `promote` and MUST NOT be read under any other model; `baseBranch` may be `null` when not configured and callers MUST NOT silently default it to \'main\'; plus `categories`, `pipelineConfig` and `plugins` from `agent_config` JSON. When `issueId` is supplied, also returns a resolved `branchConfig` layering the issue override on top of the project defaults. This tool NO LONGER carries project prose: `projectFacts` and `projectFactsConfig` were removed in ISS-1048 and a request naming either is refused by name. A project\'s guides, rules and overviews are `knowledge_entries` rows — read and write them with `forge_knowledge`, whose `injection` field (`always`, `on_demand`, `none`) is what the always-inject flag became. Action `update` (admin-gated) merges a `pipelineConfig` patch with the same invariants as `PATCH /projects/:id/pipeline-config`, and takes a `plugins` list designating the Claude Code plugins this project\'s runners must install (`[{marketplace, name, pinnedRef?, autoUpdate?}]`; marketplace is an `owner/repo`, name is kebab-case, pinnedRef is a commit SHA). UNLIKE a patch, `plugins` REPLACES the whole list — GET first, send the complete list, `null` clears it. Designation is per-project but install is per-DEVICE: a device resolves the union of every project it is bound to via `GET /api/devices/me/plugins`, so a plugin designated by one project is installed for all of them; per-project opt-out belongs in that repo\'s own `.claude/settings.json` `enabledPlugins`. Errors surface as `BAD_REQUEST: <code>: <message>`. An always-inject knowledge entry is injected verbatim into every agent system prompt for this project, under a char budget that warns on overflow rather than truncating. " +
    ALWAYS_INJECT_GUARANTEE_NOTE +
    ' ' +
    ALWAYS_INJECT_ENFORCEMENT_NOTE,
  inputSchema: zodToMcpSchema(inputSchema),
  handler: async (args) => {
    // cm:guard the named refusal comes BEFORE the parse. `inputSchema` is `.strict()`, so dropping the field alone would already answer `Unrecognized key: stateContext` — which tells a caller the argument is gone and nothing about what replaced it, on the one surface an agent reaches this config through (ISS-1000).
    if (args && typeof args === 'object' && 'stateContext' in args) {
      throw new Error(`BAD_REQUEST: RETIRED_KEY: ${RETIRED_STATE_CONTEXT_MESSAGE}`);
    }
    // ISS-1048 — same shape, same reason: `inputSchema` is `.strict()`, so dropping
    // these two fields alone would answer `Unrecognized key: projectFacts`, which
    // tells an agent the argument is gone and nothing about where the prose went.
    if (args && typeof args === 'object' && 'projectFacts' in args) {
      throw new Error(`BAD_REQUEST: RETIRED_KEY: ${RETIRED_PROJECT_FACTS_MESSAGE}`);
    }
    if (args && typeof args === 'object' && 'projectFactsConfig' in args) {
      throw new Error(`BAD_REQUEST: RETIRED_KEY: ${RETIRED_PROJECT_FACTS_CONFIG_MESSAGE}`);
    }
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
      if (input.plugins !== undefined) {
        const plugins = input.plugins;
        await patchAgentConfigKey(input.projectId, 'plugins', () =>
          mergePluginDesignations(plugins),
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

    const issueRow = await readIssueBranchInputs(input.issueId, projectId);
    if (!issueRow) throw new Error('NOT_FOUND: issue not found in project');

    const branchConfigOverride = extractIssueBranchOverride(
      issueRow as Parameters<typeof extractIssueBranchOverride>[0],
    );

    const branchConfig = resolveIssueBranches(
      { metadata: { branchConfig: branchConfigOverride } },
      { baseBranch: row.baseBranch, liveBranch: readableLiveBranch(row) },
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
