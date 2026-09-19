import { logger } from '../logger.js';

/**
 * The static, secret-free MCP server specs keyed by their shorthand name.
 * Each value is the full spec the runner writes verbatim into its temp
 * `--mcp-config`.
 */
export const MCP_CATALOG: Record<string, Record<string, unknown>> = {
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

export function isKnownMcpServerName(name: string): boolean {
  return (MCP_CATALOG_NAMES as readonly string[]).includes(name);
}

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
