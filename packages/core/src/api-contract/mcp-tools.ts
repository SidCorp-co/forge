import { byCodeUnits } from '../lib/canonical-json.js';
import {
  renderedPermission,
  type ToolPermission,
  toolActionsOf,
  toolPermissionFor,
  toolPermissionGaps,
} from '../middleware/declared-permission.js';
import { undeclaredActionPermission } from './declared-permission-field.js';

export type ListedTool = {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  /** What each action needs its caller to hold (REQ-12 BC-20), published per action. */
  permission?: ToolPermission | undefined;
};

type McpContract = { document: Record<string, unknown>; tools: number; refusals: string[] };

/**
 * Each action's `x-forge-permission`, and a refusal for each action that declares none, for a tool
 * taking no action that declares none, and for an action the declaration names but the tool does
 * not take.
 */
function permissionsOf(tool: ListedTool, refusals: string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const action of toolActionsOf(tool.inputSchema)) {
    const declared = toolPermissionFor(tool.permission, action);
    if (declared !== undefined) out[action] = renderedPermission(declared);
  }
  const { undeclared, unknown } = toolPermissionGaps(tool);
  for (const act of undeclared) refusals.push(undeclaredActionPermission(act));
  for (const act of unknown) {
    refusals.push(`${act}: declares a permission for an action the tool does not take`);
  }
  return out;
}

export function buildMcpContract(
  listing: ListedTool[],
  header: Record<string, unknown>,
): McpContract {
  const refusals: string[] = [];
  const seen = new Set<string>();
  const permissions = new Map<string, Record<string, unknown>>();
  for (const tool of listing) {
    if (seen.has(tool.name)) refusals.push(`${tool.name}: listed twice by tools/list`);
    seen.add(tool.name);
    if (tool.inputSchema?.type !== 'object') {
      refusals.push(`${tool.name}: an inputSchema whose type is not "object", which MCP requires`);
    }
    // every action names the permission it needs (REQ-12 BC-20, ISS-824)
    permissions.set(tool.name, permissionsOf(tool, refusals));
  }
  const tools = [...listing]
    .sort((a, b) => byCodeUnits(a.name, b.name))
    .map(({ name, description, inputSchema }) => {
      const declared = permissions.get(name) ?? {};
      return {
        name,
        description,
        inputSchema,
        ...(Object.keys(declared).length > 0 ? { 'x-forge-permission': declared } : {}),
      };
    });
  return { document: { ...header, tools }, tools: tools.length, refusals };
}
