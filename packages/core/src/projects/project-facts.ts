import { z } from 'zod';

// Author-defined project constants referenced from a skill body via
// `{{project:<key>}}` (see docs/skill-facts-design.md). Stored under
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
// `repo-path`, `test-urls`, `test-creds`, `integrations`.
//
// Everything else is a free-text guide note (we run an LLM — structured field
// values aren't needed; a `forge_*` MCP fetches live detail, so a how-to-use
// note injected into the prompt is enough). E.g. `build-commands`,
// `test-commands`, `git-remote`, `feature-flags` are just prose the agent reads.

export const RESERVED_PROJECT_FACT_KEYS = [
  'base-branch',
  'production-branch',
  'repo-path',
  'test-urls',
  'test-creds',
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
