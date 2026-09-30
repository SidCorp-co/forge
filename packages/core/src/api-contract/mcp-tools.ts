import { byCodeUnits } from './canonical.js';

export type ListedTool = {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
};

export type McpContract = { document: Record<string, unknown>; tools: number; refusals: string[] };

export function buildMcpContract(
  listing: ListedTool[],
  header: Record<string, unknown>,
): McpContract {
  const refusals: string[] = [];
  const seen = new Set<string>();
  for (const tool of listing) {
    if (seen.has(tool.name)) refusals.push(`${tool.name}: listed twice by tools/list`);
    seen.add(tool.name);
    if (tool.inputSchema?.type !== 'object') {
      refusals.push(`${tool.name}: an inputSchema whose type is not "object", which MCP requires`);
    }
  }
  const tools = [...listing]
    .sort((a, b) => byCodeUnits(a.name, b.name))
    .map(({ name, description, inputSchema }) => ({ name, description, inputSchema }));
  return { document: { ...header, tools }, tools: tools.length, refusals };
}
