// Author-defined project constants referenced from a skill body via
// `{{project:<key>}}`. Stored under
// `projects.agentConfig.projectFacts` as a flat kebab-case → text map.
//
// SECURITY: values are spliced VERBATIM into the device-installed SKILL.md, so
// they land on disk. NEVER store secrets here — test credentials stay in
// `previewDeploy.testCredentials` and are fetched at runtime via
// `forge_projects.get` (the built-in `{{project:test-creds}}` fact renders a
// pointer, not the secret).
//
// Reserved keys are derived (from project columns / connected integrations) and
// cannot be shadowed by this map: `base-branch`, `production-branch`,
// `repo-path`, `test-urls`, `test-creds`, `test-notes`, `integrations`.
//
// Everything else is a free-text guide note (we run an LLM — structured field
// values aren't needed; a `forge_*` MCP fetches live detail, so a how-to-use
// note injected into the prompt is enough). E.g. `build-commands`,
// `test-commands`, `git-remote`, `feature-flags` are just prose the agent reads.

import { z } from 'zod';

export const RESERVED_PROJECT_FACT_KEYS = [
  'base-branch',
  'production-branch',
  'repo-path',
  'test-urls',
  'test-creds',
  'test-notes',
  'integrations',
] as const;

const projectFactKeySchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9][a-z0-9-]*$/, 'key must be kebab-case (a-z, 0-9, hyphen)');

/** Patch shape exposed by REST/MCP: a value of `null` removes that key; the
 *  whole map `null` wipes projectFacts. */
export const projectFactsPatchSchema = z
  .record(projectFactKeySchema, z.string().max(8000).nullable())
  .nullable()
  .optional();

export type ProjectFacts = Record<string, string>;
export type ProjectFactsPatch = Record<string, string | null> | null;

// cm:why ISS-521 kept the always-inject flag in a SECOND map (`agentConfig.projectFactsConfig`) rather than widening the kebab-key→text one: `agentConfig` is jsonb, so a parallel map needed no migration, and a fact's text then evolves independently of its injection policy.
// cm:guard this tier is `mandatory` about DELIVERY and about nothing else — no gate reads the rule back. `ALWAYS_INJECT_GUARANTEE_NOTE` below is the sentence every surface offering the flag owes the owner who sets it, and ISS-936 is why.
// cm:guard the cap is on the SUM of flagged bodies and the renderer does NOT truncate at it — every body is injected whatever the total, because a half-rendered hard rule is worse than a warned-but-present one. Char-based, since core has no tokenizer; ~1.5k tokens at 4 chars/tok.
// cm:edge lockstep -> packages/core/src/prompt/facts/resolve.ts — the only reader of this cap, and the one that decides overflow is warned rather than cut
export const PROJECT_FACTS_ALWAYS_INJECT_MAX_CHARS = 6000;

// cm:guard the one sentence four surfaces owe an owner about what this flag buys, and it is a promise-shaped flag: the tier renders under "Hard rules ... Follow them exactly" and nothing reads the rule back (ISS-936). Interpolate it — never paraphrase — or the surface goes back to implying the control plane enforces the rule. `project-facts.ts` tests read the source of the ONE surface that cannot interpolate it and go red naming the file that drifted.
// cm:guard NO markdown, NO backticks: this exact string renders into an MCP tool description, a terminal-read guide body and a browser paragraph, and only the first two would swallow the syntax.
// cm:edge contract -> packages/core/src/mcp/tools/forge-config.ts — appended verbatim to the end of the tool description
// cm:edge contract -> packages/core/src/guides/registry.ts — rendered verbatim into the `project-settings-and-test-credentials` guide
// cm:edge contract -> packages/core/src/projects/project-facts-routes.ts — returned verbatim as `alwaysInjectGuarantee` on the settings tab's own GET
// cm:edge contract -> packages/web-v2/src/features/project-settings/components/project-facts-tab.tsx — the browser copy, which reads it off that response instead of holding a second copy
export const ALWAYS_INJECT_GUARANTEE_NOTE =
  'What alwaysInject guarantees is that the fact is READ, never that it was DONE. ' +
  'The full body is spliced verbatim into every agent system prompt for this project, ' +
  'and that injection is recorded per job. Nothing checks the rule was followed: no gate ' +
  'refuses a step that ignored it, no step is asked whether it complied, and no surface ' +
  'counts how often it was obeyed. Compliance is the model reading the text, not a ' +
  'guarantee the control plane is making. One obligation on this deployment does have a ' +
  'readback, and it shows the price: the UX contract is stored as ux_contract_rules rows ' +
  'with ids, its prose is compiled from them, and agents cite those ids when they record ' +
  'a ux_findings row. A free-text fact has no ids to cite, so write the rule so that an ' +
  'agent following it leaves evidence a human can look at.';

const projectFactConfigEntrySchema = z.object({ alwaysInject: z.boolean().optional() }).strict();

/** Patch shape for `projectFactsConfig`: per-key config; a value of `null`
 *  removes that key's config; the whole map `null` wipes it. */
export const projectFactsConfigPatchSchema = z
  .record(projectFactKeySchema, projectFactConfigEntrySchema.nullable())
  .nullable()
  .optional();

// `| undefined` on the optional prop matches the Zod-inferred shape under
// `exactOptionalPropertyTypes` so callers can pass parsed input directly.
export type ProjectFactConfigEntry = { alwaysInject?: boolean | undefined };
export type ProjectFactsConfig = Record<string, ProjectFactConfigEntry>;
export type ProjectFactsConfigPatch = Record<string, ProjectFactConfigEntry | null> | null;

/**
 * Merge a projectFacts patch into the existing map. Per-key: a string sets the
 * key, `null` removes it. `patch === null` wipes the whole map (returns null so
 * the caller drops the `projectFacts` agentConfig key); `undefined` is a no-op.
 * Reserved keys are silently ignored (they are derived, not author-settable).
 */
export function mergeProjectFacts(
  existing: unknown,
  patch: ProjectFactsPatch | undefined,
): Record<string, string> | null {
  const base: Record<string, string> =
    existing && typeof existing === 'object' && !Array.isArray(existing)
      ? { ...(existing as Record<string, string>) }
      : {};
  if (patch === null) return null;
  if (patch === undefined) return base;
  const reserved = new Set<string>(RESERVED_PROJECT_FACT_KEYS);
  for (const [key, value] of Object.entries(patch)) {
    if (reserved.has(key)) continue;
    if (value === null) delete base[key];
    else base[key] = value;
  }
  return base;
}

/**
 * Merge a projectFactsConfig patch into the existing map (mirrors
 * `mergeProjectFacts`). Per-key: an object sets the key's config, `null`
 * removes it. `patch === null` wipes the whole map (returns null so the caller
 * drops the `projectFactsConfig` agentConfig key); `undefined` is a no-op.
 * Reserved keys are silently ignored (they are derived, never always-injected).
 */
export function mergeProjectFactsConfig(
  existing: unknown,
  patch: ProjectFactsConfigPatch | undefined,
): ProjectFactsConfig | null {
  const base: ProjectFactsConfig =
    existing && typeof existing === 'object' && !Array.isArray(existing)
      ? { ...(existing as ProjectFactsConfig) }
      : {};
  if (patch === null) return null;
  if (patch === undefined) return base;
  const reserved = new Set<string>(RESERVED_PROJECT_FACT_KEYS);
  for (const [key, value] of Object.entries(patch)) {
    if (reserved.has(key)) continue;
    if (value === null) delete base[key];
    else base[key] = value;
  }
  return base;
}

/**
 * Select the projectFacts keys flagged `alwaysInject` and pair each with its
 * full text, preserving the `projectFacts` map's declaration order. Skips
 * reserved keys and any flagged key whose text is missing/blank (a config entry
 * can outlive its fact). Pure — the char budget is applied by the renderer.
 */
export function selectAlwaysInjectFacts(
  projectFacts: unknown,
  projectFactsConfig: unknown,
): Array<{ key: string; text: string }> {
  const facts =
    projectFacts && typeof projectFacts === 'object' && !Array.isArray(projectFacts)
      ? (projectFacts as Record<string, unknown>)
      : {};
  const config =
    projectFactsConfig &&
    typeof projectFactsConfig === 'object' &&
    !Array.isArray(projectFactsConfig)
      ? (projectFactsConfig as Record<string, ProjectFactConfigEntry | null | undefined>)
      : {};
  const reserved = new Set<string>(RESERVED_PROJECT_FACT_KEYS);
  const out: Array<{ key: string; text: string }> = [];
  for (const [key, rawText] of Object.entries(facts)) {
    if (reserved.has(key)) continue;
    if (config[key]?.alwaysInject !== true) continue;
    const text = typeof rawText === 'string' ? rawText : '';
    if (text.trim().length === 0) continue;
    out.push({ key, text });
  }
  return out;
}
