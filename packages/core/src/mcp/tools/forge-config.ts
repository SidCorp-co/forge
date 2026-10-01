import { z } from 'zod';
import { extractIssueBranchOverride, resolveIssueBranches } from '../../branches/resolve.js';
import {
  mergePluginDesignations,
  pluginDesignationsPatchSchema,
  readPluginDesignations,
} from '../../plugins/designation.js';
import { readEffectivePolicy } from '../../project-config/effective.js';
import { readProjectDocument } from '../../project-config/service.js';
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
    plugins: pluginDesignationsPatchSchema.optional(),
  })
  .strict();

const INPUT_KEYS: ReadonlySet<string> = new Set(Object.keys(inputSchema.shape));

/** Why a key this tool does not take is refused, and where the pipeline's settings live instead. */
export function unknownInputKeysMessage(keys: readonly string[]): string {
  return `forge_config takes no ${keys.map((k) => `\`${k}\``).join(', ')}. The keys are ${[...INPUT_KEYS].join(', ')}. How work runs per status — its model, its denied tools, who judges, whether intake is manual — is the project's policy: read it here as \`config.policy\`, write it with PUT /api/projects/:id/policy ({ baseRevision, document }).`;
}

async function readProjectConfig(projectId: string) {
  const row = await readProjectWithConfig(projectId);
  if (!row) throw new Error('NOT_FOUND: project not found');
  return row;
}

async function formatBaseResponse(row: Awaited<ReturnType<typeof readProjectConfig>>) {
  const ac = (row.agentConfig as Record<string, unknown> | null) ?? {};
  const [policy, document] = await Promise.all([
    readEffectivePolicy(row.id),
    readProjectDocument(row.id),
  ]);
  return {
    project: {
      id: row.id,
      slug: row.slug,
      name: row.name,
    },
    config: {
      repoPath: row.repoPath,
      baseBranch: row.baseBranch,
      categories: (ac.categories as string[] | undefined) ?? [],
      policy: policy
        ? { declared: true, revision: policy.revision, document: policy.document }
        : { declared: false, revision: null, document: null },
      projectDocument: document
        ? { declared: true, revision: document.revision, document: document.document }
        : { declared: false, revision: null, document: null },
      plugins: readPluginDesignations(ac),
    },
  };
}

export const forgeConfigTool: ContextScopedMcpToolFactory = (ctx) => ({
  name: 'forge_config',
  description:
    "Read or write project configuration. Action `get` returns `config` with `repoPath` and `baseBranch` read DIRECTLY from the `projects` table columns. `baseBranch` is where an ISS-* branch is cut from and is NOT a release fact; it may be `null` when not configured and callers MUST NOT silently default it to 'main'. Where a landed change goes is `config.projectDocument` — the project-v1 document with its `revision`, or `declared: false`: its `source.git.defaultBranch` is where work lands, its `environments` each name a `tier`, the branch they deploy from (`deploysFrom`), their deployment (a binding and a `trigger` of `on-land`, `on-request` or `provider`, or `mode: external`) and their runtime probes, the one `tier: production` environment is where a release lands, and its `promotions` are the branch crossings (`merge` or `cherry-pick`) a change takes to reach it. No production environment means this project ships nothing — `closed` means closed. The document is read-only here; write it with `PUT /api/projects/:id/config` ({ baseRevision, document }), and read what an environment runs now with `GET /api/projects/:id/environments/state`. Also `categories` and `plugins` from `agent_config` JSON, and `policy` — the project's policy-v1 document (`qa`, `intake`, `permissions`, `states`) with its `revision`, or `declared: false` where the project has none, in which case nothing dispatches there. The policy is read-only here; write it with `PUT /api/projects/:id/policy` ({ baseRevision, document }). When `issueId` is supplied, also returns a resolved `branchConfig` layering the issue override on top of the project defaults. This tool NO LONGER carries project prose: `projectFacts` and `projectFactsConfig` were removed in ISS-1048 and a request naming either is refused by name. A project's guides, rules and overviews are `knowledge_entries` rows — read and write them with `forge_knowledge`, whose `injection` field (`always`, `on_demand`, `none`) is what the always-inject flag became. Action `update` (admin-gated) takes a `plugins` list designating the Claude Code plugins this project's runners must install (`[{marketplace, name, pinnedRef?, autoUpdate?}]`; marketplace is an `owner/repo`, name is kebab-case, pinnedRef is a commit SHA). UNLIKE a patch, `plugins` REPLACES the whole list — GET first, send the complete list, `null` clears it. Designation is per-project but install is per-DEVICE: a device resolves the union of every project it is bound to via `GET /api/devices/me/plugins`, so a plugin designated by one project is installed for all of them; per-project opt-out belongs in that repo's own `.claude/settings.json` `enabledPlugins`. Errors surface as `BAD_REQUEST: <code>: <message>`. An always-inject knowledge entry is injected verbatim into every agent system prompt for this project, under a char budget that warns on overflow rather than truncating. " +
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
    const unknown =
      args && typeof args === 'object' ? Object.keys(args).filter((k) => !INPUT_KEYS.has(k)) : [];
    if (unknown.length > 0) {
      throw new Error(`BAD_REQUEST: UNKNOWN_KEY: ${unknownInputKeysMessage(unknown)}`);
    }
    const input = inputSchema.parse(args);

    if (input.action === 'update') {
      if (!input.projectId) {
        throw new Error('BAD_REQUEST: projectId is required for action=update');
      }
      await assertPrincipalIsAdmin(ctx.principal, input.projectId);
      if (input.plugins !== undefined) {
        await patchAgentConfigKeys(input.projectId, {
          plugins: mergePluginDesignations(input.plugins),
        });
      }
      const row = await readProjectConfig(input.projectId);
      return await formatBaseResponse(row);
    }

    const projectId = await resolveEffectiveProjectId(ctx, input.projectId);
    await assertPrincipalIsMember(ctx.principal, projectId);

    const row = await readProjectConfig(projectId);
    const baseResponse = await formatBaseResponse(row);

    if (!input.issueId) return baseResponse;

    const issueRow = await readIssueBranchInputs(input.issueId, projectId);
    if (!issueRow) throw new Error('NOT_FOUND: issue not found in project');

    const branchConfigOverride = extractIssueBranchOverride(
      issueRow as Parameters<typeof extractIssueBranchOverride>[0],
    );

    const branchConfig = resolveIssueBranches(
      { metadata: { branchConfig: branchConfigOverride } },
      { baseBranch: row.baseBranch },
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
