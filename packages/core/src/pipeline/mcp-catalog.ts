/**
 * Built-in catalog of known secret-free MCP servers, plus the shorthand
 * expander used by the dispatch merge layer.
 *
 * Why a catalog: forge-runner 0.4.1 writes the job's `--mcp-config` and passes
 * `--strict-mcp-config`, which makes Claude IGNORE the runner box's
 * account/repo MCP config. So a job only sees `{ forge, ...override }`. To give
 * every job the common secret-free servers (playwright, …) without making each
 * project hand-author a full stdio spec, the project's
 * `pipelineConfig.mcpServers` may use a SHORTHAND: `name: true` enables the
 * catalog default for `name`.
 *
 * Catalog entries MUST be secret-free — anything requiring a token/API key is
 * out of scope here (those flow through the integration resolvers, e.g.
 * `applyPostmanMcpServers`, which mint fresh credentials server-side per
 * dispatch). The catalog is just static, copy-pasteable specs.
 *
 * Extension point: add a new secret-free server by adding one row to
 * `MCP_CATALOG`. `playwright` is the only required entry today; `sentry` and
 * others can follow the same pattern (note: sentry's hosted MCP needs an auth
 * token, so it is intentionally NOT a catalog default).
 */

import { logger } from '../logger.js';

/**
 * The static, secret-free MCP server specs keyed by their shorthand name.
 * Each value is the full spec the runner writes verbatim into its temp
 * `--mcp-config`.
 */
export const MCP_CATALOG: Record<string, Record<string, unknown>> = {
  // CI-runner-safe flags (verified against each package's --help):
  //   --headless           runner boxes have no X server (chrome-devtools-mcp
  //                        defaults to HEADED → fails to launch on a headless
  //                        host without this).
  //   --isolated           per-session profile (in-memory for playwright, a
  //                        temp user-data-dir auto-cleaned for chrome-devtools).
  //                        Without it ALL jobs share one profile dir; a crash
  //                        (Radix portal surfaces are crash-prone) leaves a
  //                        Singleton lock that wedges the next job with
  //                        "Browser is already in use". Critical when a project
  //                        runs >1 concurrent issue on one runner.
  //   --no-sandbox         Chrome won't start under root/most containers
  //                        otherwise (chrome-devtools-mcp routes it via
  //                        --chrome-arg, which is its only sandbox knob).
  playwright: {
    type: 'stdio',
    command: 'npx',
    args: ['@playwright/mcp@latest', '--headless', '--isolated', '--no-sandbox'],
    env: {},
  },
  'chrome-devtools-mcp': {
    type: 'stdio',
    command: 'npx',
    args: [
      'chrome-devtools-mcp@latest',
      '--headless',
      '--isolated',
      '--chrome-arg=--no-sandbox',
      '--chrome-arg=--disable-setuid-sandbox',
    ],
    env: {},
  },
};

/** Names a project may enable with the `name: true` shorthand. */
export const MCP_CATALOG_NAMES = Object.keys(MCP_CATALOG);

/**
 * Integration server names resolved to secret-bearing specs by the dispatcher
 * integration resolvers (not in the catalog — they require tokens/API keys).
 * A stage opts in by setting `name: true` in its `mcpServers` config; the
 * resolver replaces the sentinel with the real spec at dispatch time.
 */
export const INTEGRATION_SERVER_NAMES = ['postman', 'epodsystem', 'sentry'] as const;

/**
 * Returns true when the server name is an integration that is resolved at
 * dispatch time (not a catalog shorthand). Covers the bare `epodsystem` name
 * AND labeled variants like `epodsystem_store_a` (ISS-558).
 */
export function isIntegrationSentinelName(name: string): boolean {
  if ((INTEGRATION_SERVER_NAMES as readonly string[]).includes(name)) return true;
  if (name.startsWith('epodsystem_')) return true;
  return false;
}

/**
 * True when `name` resolves to something at dispatch time — a catalog
 * shorthand or an integration sentinel (bare or `epodsystem_<label>`). Used
 * to validate `mcpServers` entries at config-save time (ISS-623 W1): a
 * `name: true` sentinel for a name that fails this check is a typo, not a
 * project choice, and is silently dropped by `expandMcpServers` with only a
 * `logger.warn` — this lets the schema reject it up front instead.
 */
export function isKnownMcpServerName(name: string): boolean {
  return (MCP_CATALOG_NAMES as readonly string[]).includes(name) || isIntegrationSentinelName(name);
}

/**
 * Collect every server name declared with a truthy (non-`false`/`null`)
 * value across the project-default `mcpServers` map AND every per-state
 * `states[x].mcpServers` map. Pure/shape-agnostic — accepts the raw
 * `pipelineConfig`-shaped object so both the schema (pre-parse) and the
 * dispatcher (post-parse) can reuse it without a circular import.
 */
export function collectDeclaredMcpNames(pipelineConfig: {
  mcpServers?: Record<string, unknown> | null;
  states?: Record<
    string,
    { mcpServers?: Record<string, unknown> | null } | null | undefined
  > | null;
}): Set<string> {
  const names = new Set<string>();
  const collectFrom = (map: Record<string, unknown> | null | undefined) => {
    if (!map || typeof map !== 'object') return;
    for (const [name, value] of Object.entries(map)) {
      if (value !== false && value !== null && value !== undefined) names.add(name);
    }
  };
  collectFrom(pipelineConfig.mcpServers);
  if (pipelineConfig.states) {
    for (const stageCfg of Object.values(pipelineConfig.states)) {
      if (stageCfg && typeof stageCfg === 'object') collectFrom(stageCfg.mcpServers);
    }
  }
  return names;
}

/**
 * Expand a project's shorthand `mcpServers` map into full specs.
 *
 * Per-entry rules:
 *   - value `true` for integration name → preserved as `true` sentinel so the
 *                               dispatcher's integration resolver can opt-in.
 *   - value `true` for catalog name     → the catalog spec for that name.
 *   - value `true` for unknown name     → skip + warn (neither catalog nor integration).
 *   - value object (non-null) → used verbatim (a raw custom spec; stdio
 *                               command/args/env or http url/headers).
 *   - value `false` / `null`  → omitted (explicit opt-out).
 *   - anything else           → skipped + warned (malformed entry).
 *
 * Pure function — never mutates the input, returns a fresh object. Used as the
 * BASE of the dispatch mcpServers merge (per-state overrides, then integration
 * servers, layer on top).
 */
export function expandMcpServers(
  map: Record<string, unknown> | null | undefined,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (!map || typeof map !== 'object') return out;

  for (const [name, value] of Object.entries(map)) {
    if (value === true) {
      // Integration sentinel: preserve `true` so the dispatcher resolver
      // can opt-in this stage. Do NOT expand to a catalog spec (they have none).
      if (isIntegrationSentinelName(name)) {
        out[name] = true;
        continue;
      }
      const spec = MCP_CATALOG[name];
      if (!spec) {
        logger.warn(
          { server: name, known: MCP_CATALOG_NAMES },
          'mcp-catalog: unknown shorthand server name enabled with `true`, skipping',
        );
        continue;
      }
      // Deep-ish clone the catalog spec so callers cannot mutate the shared
      // module-level catalog object.
      out[name] = structuredClone(spec);
      continue;
    }
    if (value === false || value === null) {
      // Explicit opt-out — omit.
      continue;
    }
    if (typeof value === 'object') {
      // Raw custom spec — use verbatim (cloned so the persisted config row
      // reference never leaks into the dispatch payload that gets mutated).
      out[name] = structuredClone(value) as Record<string, unknown>;
      continue;
    }
    logger.warn(
      { server: name, value },
      'mcp-catalog: malformed mcpServers entry (expected true | false | object), skipping',
    );
  }

  return out;
}
