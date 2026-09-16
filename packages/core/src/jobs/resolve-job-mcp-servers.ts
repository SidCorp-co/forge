/**
 * Dispatch-time MCP server resolution — the single place that turns (project-default map, per-state
 * overrides, granted integrations) into the final `mcpServers` map a runner receives.
 *
 * Merge order: project-default < per-state < a stage's explicit opt-outs < granted integrations.
 *
 * Adding an integration MCP inject is a declaration in that provider's own directory now; the
 * dispatcher never changes and holds no provider's name. What a granted binding gets is the same
 * contract the three resolvers this replaced shared: active-only, so an inactive or deleted
 * integration drops its entry on the next dispatch; a non-mutating merge; and credentials rendered
 * only into the dispatch payload, never persisted.
 */

import { applyGrantedMcpServers } from '../integrations/mcp-resolver.js';
import { applyStageFalseOptOuts, expandMcpServers } from '../pipeline/mcp-catalog.js';
import { resolveProjectDefaultMcpServers } from './stage-overrides.js';

export type McpServersMap = Record<string, unknown> | null;

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

  // ISS-683 — `resolveStageOverrides` returns the per-state `mcpServers` RAW
  // (unlike `resolveProjectDefaultMcpServers`, which already expands catalog
  // shorthand). Without expanding here, a per-state `{ 'chrome-devtools-mcp':
  // true }` shorthand survived the merge as the literal boolean `true` — which
  // then overwrote the correctly-expanded project-default spec by key (stage
  // wins) and reached the runner's temp `--mcp-config` write as an invalid
  // `"chrome-devtools-mcp": true` entry, silently dropping the server. Expand
  // here so per-state shorthand gets the same catalog spec as project-default;
  // integration sentinels (`postman`/`epodsystem`/`sentry`) still pass through
  // as `true` for the resolvers below (expandMcpServers preserves those).
  let map: McpServersMap = args.stageMcpServers ? expandMcpServers(args.stageMcpServers) : null;
  if (Object.keys(projectDefault.servers).length > 0 || map !== null) {
    map = { ...projectDefault.servers, ...(map ?? {}) };
  }

  // A stage's explicit `false` is an opt-OUT and has to be applied AFTER the merge, from the RAW
  // stage map: `expandMcpServers` omits a `false` rather than recording it, so before this a stage
  // that set `playwright: false` lost to a project-default `playwright: true` and the server was
  // injected anyway (ISS-1038).
  if (map !== null) map = applyStageFalseOptOuts(map, args.stageMcpServers);

  map = await applyGrantedMcpServers(args.projectId, map);

  // Browser dedupe: prefer chrome-devtools-mcp over playwright when both are present.
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
    (name) => !resolvedNames.has(name) && !(name === 'playwright' && playwrightDedupedNotDropped),
  );

  return { mcpServers: map, resolvedNames: [...resolvedNames], droppedNames };
}

// cm:why stage-less callers must still run the granted-integration resolver — resolveProjectDefaultMcpServers alone stops at catalog expansion, so a master's pane and a chat turn would receive the project's catalog servers and none of the integrations its bindings grant
// cm:edge contract -> packages/core/src/prompt/system.ts — buildChatPreamble renders these diagnostics as the `mcp-servers` block; pass them or a dropped sentinel stays invisible to the agent
export async function resolveSessionMcpServers(projectId: string): Promise<ResolvedJobMcpServers> {
  return resolveJobMcpServers({
    projectId,
    stageMcpServers: null,
    stageDeclaredNames: null,
  });
}
