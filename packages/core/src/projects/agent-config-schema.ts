import { z } from 'zod';
import { pipelineConfigSchema } from '../pipeline/pipeline-config-schema.js';
import { pluginDesignationSchema } from '../plugins/designation.js';

export const PERSONA_STYLE_MAX = 4100;

/** The assistant's per-project system-prompt addition, appended to the persona rather than replacing it. */
export const SYSTEM_PROMPT_MAX = 20_000;

export const agentConfigSchema = z
  .object({
    /** Read by ~14 call sites; its inner shape and invariants are `pipelineConfigSchema`'s own. */
    pipelineConfig: pipelineConfigSchema.optional(),
    /** Read by `plugins/designation.ts:readPluginDesignations`, unioned per device by `GET /api/devices/me/plugins`. */
    plugins: z.array(pluginDesignationSchema).optional(),
    /** Read by `assistant/system-prompt.ts:buildSystemPrompt` — additive tone on top of the persona. */
    personaStyle: z.string().max(PERSONA_STYLE_MAX).optional(),
    /** Read by `assistant/system-prompt.ts:buildSystemPrompt` — the project's own prompt addition. */
    systemPrompt: z.string().max(SYSTEM_PROMPT_MAX).optional(),
    /** Read by `integrations/rocketchat/answer-mode.ts:readRocketChatAnswerMode`. */
    rocketChatAnswerMode: z.enum(['fast', 'agent']).optional(),
    /** Read by `mcp/tools/forge-config.ts:formatBaseResponse` — the issue categories this project offers. */
    categories: z.array(z.string().trim().min(1).max(100)).max(50).optional(),
  })
  .strict();

export type AgentConfigDocument = z.infer<typeof agentConfigSchema>;

export type AgentConfigKey = keyof AgentConfigDocument;

/** Every declared key, in declaration order. */
export const AGENT_CONFIG_KEYS = Object.keys(agentConfigSchema.shape) as AgentConfigKey[];

export const AGENT_CONFIG_DOORS: Record<AgentConfigKey, string> = {
  pipelineConfig:
    '`PATCH /api/projects/:id/pipeline-config`, or MCP `forge_config` action=update with `pipelineConfig`',
  plugins: '`PATCH /api/projects/:id/plugins`, or MCP `forge_config` action=update with `plugins`',
  personaStyle: 'the `personaStyle` field on `PATCH /api/projects/:id`',
  systemPrompt: 'the `systemPrompt` field on `PATCH /api/projects/:id`',
  rocketChatAnswerMode: 'the `rocketChatAnswerMode` field on `PATCH /api/projects/:id`',
  categories: 'the `categories` field on `PATCH /api/projects/:id`',
};

/**
 * The keys removed from the column by migration `0285`, each with the thing that owns its value.
 *
 * Retired BY NAME rather than dropped: a key deleted from a non-strict zod object turns an
 * operator's save into a 200 and a silent discard, which is the defect ISS-994 and ISS-1000
 * established and the one this retirement exists to avoid repeating.
 */
export const RETIRED_AGENT_CONFIG_KEYS: Record<string, string> = {
  repoPath:
    'agentConfig.repoPath decides nothing — the checkout a project names is the `projects.repo_path` column, which is what `forge_config` serves and what every reader in this tree reads. Two of the copies stored in this jsonb disagreed with their column. Set it with the `repoPath` field on `PATCH /api/projects/:id`, and remove repoPath from agentConfig.',
  baseBranch:
    'agentConfig.baseBranch decides nothing — the branch work is cut from is the `projects.base_branch` column, read by `branches/resolve.ts:resolveIssueBranches`. One copy stored in this jsonb said `main` against a column of `release/stg`. Set it with the `baseBranch` field on `PATCH /api/projects/:id`, and remove baseBranch from agentConfig.',
  productionBranch:
    'agentConfig.productionBranch names a column that does not exist: ISS-1046 made it `projects.live_branch`, which may only be read under `releaseModel` = `promote` and means nothing under `none` or `publish`. Set it with the `liveBranch` field on `PATCH /api/projects/:id`, together with `releaseModel`, and remove productionBranch from agentConfig.',
  activeDeviceId:
    'agentConfig.activeDeviceId decides nothing — the device a project defaults to is the `projects.default_device_id` column, and no dispatcher has ever read this key. Set it with the `defaultDeviceId` field on `PATCH /api/projects/:id`, and remove activeDeviceId from agentConfig.',
  runnerFallback:
    'agentConfig.runnerFallback decides nothing — ISS-232 Phase 3 replaced the type-chain fallback with a deterministic primary-then-standby pick, and no selector has read this key since. The live per-stage override is `pipelineConfig.states[*].runner`. Remove runnerFallback from agentConfig.',
};

/** The message a raw `agentConfig` record carrying a DECLARED key is refused with. */
export function agentConfigDoorMessage(key: AgentConfigKey): string {
  return `agentConfig is no longer a field on PATCH /api/projects/:id — every value it held has a door of its own, so a wholesale record can no longer overwrite a sibling key a concurrent write just set. Write \`${key}\` through ${AGENT_CONFIG_DOORS[key]}.`;
}

export const AGENT_CONFIG_CLEAR_GUIDE =
  'agentConfig is no longer a field on PATCH /api/projects/:id, and it cannot be cleared wholesale. Clear each value through its own door instead: send `personaStyle`, `systemPrompt`, `rocketChatAnswerMode` or `categories` as null on PATCH /api/projects/:id, or `plugins` as null on PATCH /api/projects/:id/plugins. `pipelineConfig` is the one value with no clear — its door merges a patch onto the stored document, so a key already stored there cannot be removed through it at all.';

export function agentConfigUndeclaredMessage(key: string): string {
  return `agentConfig.${key} is not a key this project's configuration declares, so nothing would ever read it. The declared keys are ${AGENT_CONFIG_KEYS.join(', ')}, each written through its own door. Refused by name rather than stored, and rather than answered 200 and dropped.`;
}

export function refuseAgentConfigRecord(
  raw: unknown,
  ctx: z.RefinementCtx,
  path: (string | number)[] = ['agentConfig'],
  alreadyNamed: ReadonlySet<string> = new Set(),
): void {
  if (raw === null || raw === undefined) {
    ctx.addIssue({ code: 'custom', path, message: AGENT_CONFIG_CLEAR_GUIDE });
    return;
  }
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    ctx.addIssue({
      code: 'custom',
      path,
      message: `agentConfig is no longer a field on PATCH /api/projects/:id, and what arrived is a ${Array.isArray(raw) ? 'list' : typeof raw} rather than a document in any case. ${AGENT_CONFIG_CLEAR_GUIDE}`,
    });
    return;
  }
  let spoke = false;
  const declared = new Set<string>(AGENT_CONFIG_KEYS);
  for (const key of Object.keys(raw as Record<string, unknown>)) {
    spoke = true;
    if (alreadyNamed.has(key)) continue;
    const retired = RETIRED_AGENT_CONFIG_KEYS[key];
    if (retired) {
      ctx.addIssue({ code: 'custom', path: [...path, key], message: retired });
      continue;
    }
    if (declared.has(key)) {
      ctx.addIssue({
        code: 'custom',
        path: [...path, key],
        message: agentConfigDoorMessage(key as AgentConfigKey),
      });
      continue;
    }
    ctx.addIssue({
      code: 'custom',
      path: [...path, key],
      message: agentConfigUndeclaredMessage(key),
    });
  }
  if (!spoke) ctx.addIssue({ code: 'custom', path, message: AGENT_CONFIG_CLEAR_GUIDE });
}
