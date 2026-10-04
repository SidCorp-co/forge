import { jobsPorts, type ProducedMcpServer } from './ports.js';

export type McpServersMap = Record<string, unknown> | null;

export interface ResolvedJobMcpServers {
  /** Final map for the runner payload (null = no servers). */
  mcpServers: McpServersMap;
  /** Server names present in the final map. */
  resolvedNames: string[];
  /** ISS-1191 — every name the granted-integration pass produced, each carrying
   *  the binding that produced it. Two bindings of one provider can land on a
   *  single name, so the name alone identifies neither. */
  integrationServers: ProducedMcpServer[];
}

/** The MCP servers a job or session of this project carries: its granted integration bindings. */
export async function resolveJobMcpServers(args: {
  projectId: string;
}): Promise<ResolvedJobMcpServers> {
  const granted = await jobsPorts().mcpServers.applyGrantedMcpServers(args.projectId);
  return {
    mcpServers: granted.map,
    resolvedNames: Object.keys(granted.map ?? {}),
    integrationServers: granted.produced,
  };
}

export async function resolveSessionMcpServers(projectId: string): Promise<ResolvedJobMcpServers> {
  return resolveJobMcpServers({ projectId });
}
