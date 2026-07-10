/**
 * Dispatch-time MCP server resolution — the single place that turns
 * (project-default map, per-state overrides, integration sentinels) into the
 * final `mcpServers` map a runner receives.
 *
 * Merge order: project-default < per-state < integration resolvers.
 *
 * Adding an integration MCP inject = one entry in
 * `INTEGRATION_MCP_RESOLVERS`; the dispatcher never changes. Every resolver
 * shares the same contract: active-only (an inactive/deleted integration
 * drops its entry on the next dispatch), non-mutating merge, credentials
 * rendered only into the dispatch payload (never persisted).
 */

import { applyEpodsystemMcpServers } from '../integrations/epodsystem/resolver.js';
import { applyPostmanMcpServers } from '../integrations/postman/resolver.js';
import { applySentryMcpServers } from '../integrations/sentry/resolver.js';
import { isIntegrationSentinelName } from '../pipeline/mcp-catalog.js';
import { resolveProjectDefaultMcpServers } from './stage-overrides.js';

export type McpServersMap = Record<string, unknown> | null;

type IntegrationMcpResolver = (
  projectId: string,
  current: McpServersMap,
) => Promise<McpServersMap>;

/** ISS-336 (postman) · ISS-387 (epodsystem) · ISS-524 (sentry). Order is the
 *  historical chain order; resolvers are name-keyed so it rarely matters. */
const INTEGRATION_MCP_RESOLVERS: ReadonlyArray<IntegrationMcpResolver> = [
  applyPostmanMcpServers,
  applyEpodsystemMcpServers,
  applySentryMcpServers,
];

/**
 * ISS-581 — belt-and-suspenders sweep: after integration resolvers run, delete
 * any remaining `true` sentinel for a known integration name. The resolvers
 * already strip their own sentinels; this catches a declared-but-no-active-
 * integration case so a bogus `true` never reaches the runner payload.
 */
export function sweepIntegrationSentinels(map: McpServersMap): McpServersMap {
  if (!map) return map;
  let dirty = false;
  for (const [k, v] of Object.entries(map)) {
    if (v === true && isIntegrationSentinelName(k)) {
      dirty = true;
      break;
    }
  }
  if (!dirty) return map;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(map)) {
    if (v === true && isIntegrationSentinelName(k)) continue;
    out[k] = v;
  }
  return Object.keys(out).length > 0 ? out : null;
}

/**
 * ISS-581 — when both playwright and chrome-devtools-mcp are present in the
 * merged map, drop playwright in favour of chrome-devtools-mcp (the preferred
 * browser MCP for pipeline jobs).
 */
export function dedupeBrowserServers(map: McpServersMap): McpServersMap {
  if (!map) return map;
  if (map.playwright && map['chrome-devtools-mcp']) {
    const { playwright: _dropped, ...rest } = map;
    return rest;
  }
  return map;
}

export interface ResolvedJobMcpServers {
  /** Final map for the runner payload (null = no servers). */
  mcpServers: McpServersMap;
  /** Server names present in the final map. */
  resolvedNames: string[];
  /** ISS-623 W2 — declared (project-default or per-state) names that did NOT
   *  survive resolution, minus the intentional playwright browser-dedupe. */
  droppedNames: string[];
}

/**
 * Resolve the final MCP server map for one dispatch.
 *
 * `stageMcpServers` / `stageDeclaredNames` come from the per-state stage
 * overrides (already fresh clones — see resolveStageOverrides); the
 * project-default map is loaded here and laid underneath.
 */
export async function resolveJobMcpServers(args: {
  projectId: string;
  stageMcpServers: McpServersMap;
  stageDeclaredNames: string[] | null | undefined;
}): Promise<ResolvedJobMcpServers> {
  // Project-default MCP servers are the BASE of the merge: load + expand
  // `pipelineConfig.mcpServers` (catalog shorthand → full specs) and lay the
  // per-state `mcpServers` ON TOP (a per-state entry overrides the default by
  // server name).
  const projectDefault = await resolveProjectDefaultMcpServers(args.projectId);
  // ISS-623 W2 — the truthy sentinel names declared BEFORE the merge/expand/
  // integration-resolve chain runs, so we can diff them against what actually
  // made it into the final map and surface anything that silently dropped.
  const declaredNames = new Set<string>([
    ...projectDefault.declaredNames,
    ...(args.stageDeclaredNames ?? []),
  ]);

  let map: McpServersMap = args.stageMcpServers;
  if (Object.keys(projectDefault.servers).length > 0 || map !== null) {
    map = { ...projectDefault.servers, ...(map ?? {}) };
  }

  for (const applyIntegration of INTEGRATION_MCP_RESOLVERS) {
    map = await applyIntegration(args.projectId, map);
  }

  // (1) sentinel sweep: drop any leftover `true` for integration names
  // (declared but no active integration); (2) browser dedupe: prefer
  // chrome-devtools-mcp over playwright when both are present.
  map = sweepIntegrationSentinels(map);
  const beforeBrowserDedupe = new Set(Object.keys(map ?? {}));
  map = dedupeBrowserServers(map);

  // ISS-623 W2 — diff the declared sentinel names against what actually
  // resolved. `playwright` dropped ONLY via the browser dedupe (both it and
  // chrome-devtools-mcp resolved, and chrome-devtools-mcp won) is an
  // intentional preference, not a failure to resolve — exclude it so the
  // agent isn't warned about a server it never needed.
  const resolvedNames = new Set(Object.keys(map ?? {}));
  const playwrightDedupedNotDropped =
    beforeBrowserDedupe.has('playwright') && !resolvedNames.has('playwright');
  const droppedNames = [...declaredNames].filter(
    (name) =>
      !resolvedNames.has(name) && !(name === 'playwright' && playwrightDedupedNotDropped),
  );

  return { mcpServers: map, resolvedNames: [...resolvedNames], droppedNames };
}
