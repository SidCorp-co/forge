import { z } from 'zod';
import { extractIssueBranchOverride, resolveIssueBranches } from '../../branches/resolve.js';
import {
  PIPELINE_CONFIG_DEFAULTS,
  pipelineConfigPatchSchema,
  pipelineConfigSchema,
} from '../../pipeline/pipeline-config-schema.js';
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
  patchAgentConfigKeys,
  RETIRED_STATE_CONTEXT_MESSAGE,
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

/** What a write says it read, so the store can refuse one whose ground moved. */
export const PIPELINE_CONFIG_BASE_MESSAGE =
  '`pipelineConfig` is a patch now, and a patch says what it read: send `pipelineConfigBase` beside it, holding the `config.pipelineConfig` that `forge_config action=get` answered with. The patch itself names ONLY the keys you are changing (`null` deletes one) — a whole document sent here replaced every key it did not carry, which is how one settings section discarded another\'s saved change. So: `get`, then `update` with `{ pipelineConfig: { intakeGate: { enabled: true } }, pipelineConfigBase: <what get returned> }`.';

const inputSchema = z
  .object({
    action: z.enum(['get', 'update']).default('get'),
    projectId: z.uuid().optional(),
    issueId: z.uuid().optional(),
    pipelineConfig: pipelineConfigPatchSchema.optional(),
    pipelineConfigBase: z.record(z.string(), z.unknown()).optional(),
    plugins: pluginDesignationsPatchSchema.optional(),
  })
  .strict();

async function readProjectConfig(projectId: string) {
  const row = await readProjectWithConfig(projectId);
  if (!row) throw new Error('NOT_FOUND: project not found');
  return row;
}

/**
 * What `update` compares a base against, so `get` and `update` are talking about the same
 * document: the stored keys with this codebase's defaults filled in for the ones it has none of.
 */
function effectivePipelineConfig(ac: Record<string, unknown>): Record<string, unknown> {
  const stored = (ac.pipelineConfig ?? {}) as Record<string, unknown>;
  const parsed = pipelineConfigSchema.safeParse(stored);
  return {
    ...PIPELINE_CONFIG_DEFAULTS,
    ...(parsed.success ? parsed.data : stored),
  } as Record<string, unknown>;
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
      pipelineConfig: effectivePipelineConfig(ac),
      plugins: readPluginDesignations(ac),
    },
  };
}

export const forgeConfigTool: ContextScopedMcpToolFactory = (ctx) => ({
  name: 'forge_config',
  description:
    "Read or write project configuration. Action `get` returns `config` with `repoPath`, `baseBranch`, `liveBranch`, `releaseModel` and `releaseStrategy` read DIRECTLY from the `projects` table columns. `releaseModel` is `none` (no release step — `closed` means closed), `promote` (the release moves code from `baseBranch` to `liveBranch`, by `releaseStrategy`) or `publish` (the ref does not change; the release is an act on a live deploy binding). `liveBranch` is non-null only under `promote` and MUST NOT be read under any other model; `baseBranch` may be `null` when not configured and callers MUST NOT silently default it to 'main'; plus `categories`, `plugins` and `pipelineConfig` from `agent_config` JSON — `pipelineConfig` is the EFFECTIVE document, this codebase's defaults with the project's stored keys over them, which is exactly what `update` compares a `pipelineConfigBase` against. When `issueId` is supplied, also returns a resolved `branchConfig` layering the issue override on top of the project defaults. This tool NO LONGER carries project prose: `projectFacts` and `projectFactsConfig` were removed in ISS-1048 and a request naming either is refused by name. A project's guides, rules and overviews are `knowledge_entries` rows — read and write them with `forge_knowledge`, whose `injection` field (`always`, `on_demand`, `none`) is what the always-inject flag became. Action `update` (admin-gated) applies a `pipelineConfig` PATCH with the same invariants as `PATCH /projects/:id/pipeline-config`: it names ONLY the keys it is changing (`null` deletes one, a key it does not name is untouched at any depth) and it carries `pipelineConfigBase`, the `config.pipelineConfig` a preceding `get` answered with. A write whose base disagrees with what is stored at a path it writes is refused `CONFIG_STALE` naming each path, what you read and what is there now, and NOTHING is written — read again and resend. Sending a whole document is refused by name. It also takes a `plugins` list designating the Claude Code plugins this project's runners must install (`[{marketplace, name, pinnedRef?, autoUpdate?}]`; marketplace is an `owner/repo`, name is kebab-case, pinnedRef is a commit SHA). UNLIKE a patch, `plugins` REPLACES the whole list — GET first, send the complete list, `null` clears it. Designation is per-project but install is per-DEVICE: a device resolves the union of every project it is bound to via `GET /api/devices/me/plugins`, so a plugin designated by one project is installed for all of them; per-project opt-out belongs in that repo's own `.claude/settings.json` `enabledPlugins`. Errors surface as `BAD_REQUEST: <code>: <message>`. An always-inject knowledge entry is injected verbatim into every agent system prompt for this project, under a char budget that warns on overflow rather than truncating. " +
    ALWAYS_INJECT_GUARANTEE_NOTE +
    ' ' +
    ALWAYS_INJECT_ENFORCEMENT_NOTE,
  inputSchema: zodToMcpSchema(inputSchema),
  handler: async (args) => {
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
        if (!input.pipelineConfigBase) {
          throw new Error(`BAD_REQUEST: CONFIG_PATCH_SHAPE: ${PIPELINE_CONFIG_BASE_MESSAGE}`);
        }
        try {
          await updatePipelineConfig({
            projectId: input.projectId,
            patch: input.pipelineConfig,
            base: input.pipelineConfigBase,
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
        await patchAgentConfigKeys(input.projectId, {
          plugins: mergePluginDesignations(input.plugins),
        });
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
