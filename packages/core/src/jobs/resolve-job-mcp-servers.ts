import { applyGrantedMcpServers, type ProducedMcpServer } from '../integrations/mcp-resolver.js';

export type McpServersMap = Record<string, unknown> | null;

export interface ResolvedJobMcpServers {
  /** Final map for the runner payload (null = no servers). */
  mcpServers: McpServersMap;
  /** Server names present in the final map. */
  resolvedNames: string[];
  // cm:hack ISS-5 until:S3d declares a project's MCP servers in the project document — the
  // project-declared source went with the old pipeline config, so nothing is declared and nothing
  // can drop; the field stays because the runner and the chat preamble read it.
  droppedNames: string[];
  /** ISS-1191 — every name the granted-integration pass produced, each carrying
   *  the binding that produced it. Two bindings of one provider can land on a
   *  single name, so the name alone identifies neither. */
  integrationServers: ProducedMcpServer[];
}

/** The MCP servers a job or session of this project carries: its granted integration bindings. */
export async function resolveJobMcpServers(args: {
  projectId: string;
}): Promise<ResolvedJobMcpServers> {
  const granted = await applyGrantedMcpServers(args.projectId, null);
  return {
    mcpServers: granted.map,
    resolvedNames: Object.keys(granted.map ?? {}),
    droppedNames: [],
    integrationServers: granted.produced,
  };
}

export async function resolveSessionMcpServers(projectId: string): Promise<ResolvedJobMcpServers> {
  return resolveJobMcpServers({ projectId });
}
