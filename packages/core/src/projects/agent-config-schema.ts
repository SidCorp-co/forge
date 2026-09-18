/**
 * ISS-1070 — the declared shape of `projects.agent_config`, and one door per value.
 *
 * This file is the ONLY place the column's key set is stated. Three things live here and nothing
 * else does: the strict schema over the whole document, the door each declared key is written
 * through, and the message a retired key is refused with. A value's own validation belongs at its
 * door — `pipelineConfigSchema` for `pipelineConfig`, `pluginDesignationsPatchSchema` for
 * `plugins` — and this file references those schemas rather than restating them.
 *
 * Before this, `PATCH /api/projects/:id` declared `agentConfig: z.record(z.string(), z.unknown())`
 * and assigned it onto the column, which was a door past every refusal `pipelineConfigPatchSchema`
 * makes. It closed because the two keys that had no named field — `systemPrompt` and `categories`
 * — got one, not because the record was narrowed underneath a caller still using it.
 */

import { z } from 'zod';
import { pipelineConfigSchema } from '../pipeline/pipeline-config-schema.js';
import { pluginDesignationSchema } from '../plugins/designation.js';

/**
 * The reply-style knob's cap, which is 4,100 rather than 4,000 to leave room for what migration
 * 0245 PREPENDED — 82 characters plus a newline — to every stored value. Stated once here and read
 * by the route's own field so the two cannot drift.
 */
export const PERSONA_STYLE_MAX = 4100;

/** The assistant's per-project system-prompt addition, appended to the persona rather than replacing it. */
export const SYSTEM_PROMPT_MAX = 20_000;

// cm:guard every key here has a READER in this tree, and that is the admission test rather than a census of what is stored. `systemPrompt` is stored on no project on this fleet (measured over all 32 rows, 2026-09-18) and is read by `assistant/system-prompt.ts:buildSystemPrompt`, so a schema built from what the column happens to hold would refuse a key the assistant depends on.
// cm:edge lockstep -> packages/core/src/db/schema.ts — the `agent_config` column this describes
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

/**
 * The one writer each declared value is reached through.
 *
 * A door is the shared logical writer and not a transport: `pipelineConfig` and `plugins` each have
 * a REST endpoint and an MCP action, and both land on one function. What "one door per value" rules
 * out is a second PLACE that decides what the stored value becomes.
 */
// cm:guard held to `AGENT_CONFIG_KEYS` by `agent-config-doors.test.ts` in BOTH directions: a key declared with no door, and a door naming a key nothing declares, each go red. That test is the whole of "one door per value" — this object is prose until something enumerates it.
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
// cm:guard this map and the `retired_keys` array in `drizzle/migrations/0285_agent_config_shadow_keys.sql` are the same five names. The migration deletes what this refuses; a name in one and not the other is either a key the door refuses and the column keeps, or one the column loses and the door still accepts. `agent-config-doors.test.ts` reads the .sql and holds them together.
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

/** The message a raw `agentConfig` record carrying a key nothing declares is refused with. */
export function agentConfigUndeclaredMessage(key: string): string {
  return `agentConfig.${key} is not a key this project's configuration declares, so nothing would ever read it. The declared keys are ${AGENT_CONFIG_KEYS.join(', ')}, each written through its own door. Refused by name rather than stored, and rather than answered 200 and dropped.`;
}

/**
 * Walk a raw `agentConfig` record and add one refusal per key it carries.
 *
 * Most specific first: a retired key gets its own message naming the column that owns its value, a
 * declared key gets the door that writes it, and anything else is named as undeclared. A record
 * carrying three keys is refused three times, at three paths, because a caller fixing one at a time
 * would otherwise make three round trips to learn three things this call already knows.
 *
 * `alreadyNamed` is for the keys whose retirement message lives elsewhere and whose owner already
 * added it — `stateContext` (ISS-1000), `projectFacts` and `projectFactsConfig` (ISS-1048). Naming
 * them again here would answer one key twice at one path with two different sentences, and the
 * caller cannot tell which is the instruction.
 */
export function refuseAgentConfigRecord(
  raw: unknown,
  ctx: z.RefinementCtx,
  path: (string | number)[] = ['agentConfig'],
  alreadyNamed: ReadonlySet<string> = new Set(),
): void {
  if (raw === null || raw === undefined) {
    ctx.addIssue({
      code: 'custom',
      path,
      message:
        'agentConfig is no longer a field on PATCH /api/projects/:id. It cannot be cleared wholesale either — each value is cleared through its own door by sending that field as null.',
    });
    return;
  }
  if (typeof raw !== 'object') {
    ctx.addIssue({
      code: 'custom',
      path,
      message: agentConfigUndeclaredMessage('<not an object>'),
    });
    return;
  }
  const declared = new Set<string>(AGENT_CONFIG_KEYS);
  for (const key of Object.keys(raw as Record<string, unknown>)) {
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
}
