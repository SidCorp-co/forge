import { z } from "zod";

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
	"base-branch",
	"production-branch",
	"repo-path",
	"test-urls",
	"test-creds",
	"integrations",
] as const;

const projectFactKeySchema = z
	.string()
	.min(1)
	.max(64)
	.regex(/^[a-z0-9][a-z0-9-]*$/, "key must be kebab-case (a-z, 0-9, hyphen)");

/** Patch shape exposed by REST/MCP: a value of `null` removes that key; the
 *  whole map `null` wipes projectFacts. */
export const projectFactsPatchSchema = z
	.record(projectFactKeySchema, z.string().max(8000).nullable())
	.nullable()
	.optional();

export type ProjectFacts = Record<string, string>;
export type ProjectFactsPatch = Record<string, string | null> | null;

// ── Always-inject tier (ISS-521) ────────────────────────────────────────────
//
// A parallel metadata map, stored alongside `projectFacts` under
// `agentConfig.projectFactsConfig`, that marks individual keys for verbatim
// injection into the system prompt (like a `mandatory` ForgeFact) instead of
// the default fetch-on-demand pointer. Kept SEPARATE from the kebab-key→text
// map so the existing `projectFacts` schema is untouched (no migration —
// agentConfig is jsonb) and a fact's text and its injection policy evolve
// independently.
//
// Hard cap on the SUM of always-injected text so an over-eager flag can't bloat
// every prompt. Char-based (no tokenizer in core); ~1.5k tokens at 4 chars/tok.
// The renderer injects up to the cap in declaration order and warns on overflow;
// the UI surfaces the same budget as a meter.
export const PROJECT_FACTS_ALWAYS_INJECT_MAX_CHARS = 6000;

const projectFactConfigEntrySchema = z
	.object({ alwaysInject: z.boolean().optional() })
	.strict();

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
export type ProjectFactsConfigPatch = Record<
	string,
	ProjectFactConfigEntry | null
> | null;

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
		existing && typeof existing === "object" && !Array.isArray(existing)
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
		existing && typeof existing === "object" && !Array.isArray(existing)
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
		projectFacts &&
		typeof projectFacts === "object" &&
		!Array.isArray(projectFacts)
			? (projectFacts as Record<string, unknown>)
			: {};
	const config =
		projectFactsConfig &&
		typeof projectFactsConfig === "object" &&
		!Array.isArray(projectFactsConfig)
			? (projectFactsConfig as Record<
					string,
					ProjectFactConfigEntry | null | undefined
				>)
			: {};
	const reserved = new Set<string>(RESERVED_PROJECT_FACT_KEYS);
	const out: Array<{ key: string; text: string }> = [];
	for (const [key, rawText] of Object.entries(facts)) {
		if (reserved.has(key)) continue;
		if (config[key]?.alwaysInject !== true) continue;
		const text = typeof rawText === "string" ? rawText : "";
		if (text.trim().length === 0) continue;
		out.push({ key, text });
	}
	return out;
}
