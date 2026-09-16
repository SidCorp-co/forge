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
 * Catalog entries MUST be secret-free, and since ISS-1071 that is the whole of this file's scope.
 * An integration reaches an agent because its BINDING grants it — `integration_bindings.agent_access`,
 * resolved by `integrations/mcp-resolver.ts` — and no name in this map, and no name in a project's
 * `pipelineConfig.mcpServers`, has anything to do with it. This file used to carry the sentinel
 * vocabulary those resolvers read; the write path now refuses an integration name here by name.
 *
 * Extension point: add a new secret-free server by adding one row to `MCP_CATALOG`.
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
 * True when `name: true` resolves to a catalog spec at dispatch time.
 *
 * Used to validate `mcpServers` entries on the WRITE path (ISS-623 W1): a `name: true` for a name
 * that fails this check is a typo, not a project choice, and `expandMcpServers` drops it with only
 * a `logger.warn`, so the write door refuses it up front instead.
 */
// cm:guard the check that reads this lives on the WRITE schema and must never move back onto
// `pipelineConfigSchema` — four control-plane readers `safeParse` that schema and take a silent
// branch on failure (`devices/admissible.ts`, `pipeline/autonomous-project.ts`,
// `pipeline/orchestrator.ts`, `pipeline/pipeline-config-service.ts`), so a name check there stops a
// project dispatching with nothing reporting it. That is the ISS-807 shape (ISS-1071 rule 7).
export function isKnownMcpServerName(name: string): boolean {
  return (MCP_CATALOG_NAMES as readonly string[]).includes(name);
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
 *   - value `true` for catalog name → the catalog spec for that name.
 *   - value `true` for unknown name → skip + warn.
 *   - value object (non-null) → used verbatim (a raw custom spec; stdio command/args/env or
 *                               http url/headers).
 *   - value `false` / `null`  → omitted here, and recorded by `applyStageFalseOptOuts` where it
 *                               came from a stage, because an omission cannot override.
 *   - anything else           → skipped + warned (malformed entry).
 *
 * Pure function — never mutates the input, returns a fresh object. Used as the BASE of the dispatch
 * mcpServers merge, which the granted integration servers then layer on top of.
 */
export function expandMcpServers(
  map: Record<string, unknown> | null | undefined,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (!map || typeof map !== 'object') return out;

  for (const [name, value] of Object.entries(map)) {
    if (value === true) {
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

/**
 * Remove from a merged map every name a STAGE set to `false`.
 *
 * ISS-1038's defect, carried into this change because it survives it. `expandMcpServers` omits a
 * `false` entry rather than recording it, so the stage map that reaches the merge no longer holds
 * the name at all — and a stage that set `playwright: false` lost to a project-default
 * `playwright: true` and received the server anyway. A control an operator can set that changes
 * nothing is a silent substitution, so the opt-out is applied AFTER the merge, from the RAW stage
 * map, where the `false` is still visible.
 *
 * The price: a project relying on an ignored `false` stops receiving that server. That is the fix,
 * and it is the reason this is stated rather than quietly landed.
 */
// cm:guard reads the RAW stage map, never the expanded one — expansion is what loses the `false`,
// so calling this with `expandMcpServers(stage)` would make it a no-op that still type-checks.
export function applyStageFalseOptOuts(
  merged: Record<string, unknown>,
  rawStageMap: Record<string, unknown> | null | undefined,
): Record<string, unknown> {
  if (!rawStageMap || typeof rawStageMap !== 'object') return merged;
  const optedOut = Object.entries(rawStageMap)
    .filter(([, value]) => value === false || value === null)
    .map(([name]) => name);
  if (optedOut.length === 0) return merged;
  const out: Record<string, unknown> = { ...merged };
  for (const name of optedOut) delete out[name];
  return out;
}
