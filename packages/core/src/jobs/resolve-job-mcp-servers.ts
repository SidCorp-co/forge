import { applyGrantedMcpServers } from '../integrations/mcp-resolver.js';
import { applyStageFalseOptOuts, expandMcpServers } from '../pipeline/mcp-catalog.js';
import { resolveProjectDefaultMcpServers } from './stage-overrides.js';

export type McpServersMap = Record<string, unknown> | null;

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
  /** ISS-1191 — the names the granted-integration pass produced, so a reader can
   *  tell an integration-sourced server from a project-declared one, and can tell
   *  a binding that delivered from one that only looked as though it would. */
  integrationNames: string[];
}

export async function resolveJobMcpServers(args: {
  projectId: string;
  stageMcpServers: McpServersMap;
  stageDeclaredNames: string[] | null | undefined;
}): Promise<ResolvedJobMcpServers> {
  const projectDefault = await resolveProjectDefaultMcpServers(args.projectId);
  // ISS-623 W2 — the truthy sentinel names declared BEFORE the merge/expand/
  // integration-resolve chain runs, so we can diff them against what actually
  // made it into the final map and surface anything that silently dropped.
  const declaredNames = new Set<string>([
    ...projectDefault.declaredNames,
    ...(args.stageDeclaredNames ?? []),
  ]);

  let map: McpServersMap = args.stageMcpServers ? expandMcpServers(args.stageMcpServers) : null;
  if (Object.keys(projectDefault.servers).length > 0 || map !== null) {
    map = { ...projectDefault.servers, ...(map ?? {}) };
  }

  if (map !== null) map = applyStageFalseOptOuts(map, args.stageMcpServers);

  const granted = await applyGrantedMcpServers(args.projectId, map);
  map = granted.map;

  // Browser dedupe: prefer chrome-devtools-mcp over playwright when both are present.
  const beforeBrowserDedupe = new Set(Object.keys(map ?? {}));
  map = dedupeBrowserServers(map);

  const resolvedNames = new Set(Object.keys(map ?? {}));
  const playwrightDedupedNotDropped =
    beforeBrowserDedupe.has('playwright') && !resolvedNames.has('playwright');
  const droppedNames = [...declaredNames].filter(
    (name) => !resolvedNames.has(name) && !(name === 'playwright' && playwrightDedupedNotDropped),
  );

  return {
    mcpServers: map,
    resolvedNames: [...resolvedNames],
    droppedNames,
    integrationNames: granted.names,
  };
}

export async function resolveSessionMcpServers(projectId: string): Promise<ResolvedJobMcpServers> {
  return resolveJobMcpServers({
    projectId,
    stageMcpServers: null,
    stageDeclaredNames: null,
  });
}
