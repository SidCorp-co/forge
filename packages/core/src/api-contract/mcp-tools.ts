import { byCodeUnits } from '../lib/canonical-json.js';
import {
  renderedPermission,
  type ToolPermission,
  toolPermissionFor,
} from '../middleware/declared-permission.js';
import {
  UNDECLARED_PERMISSION_ACTIONS,
  undeclaredActionPermission,
  undeclaredPermissionAmnesties,
} from './permission-amnesty.js';

export type ListedTool = {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  /** What each action needs its caller to hold (REQ-12 BC-20), published per action. */
  permission?: ToolPermission | undefined;
};

type McpContract = { document: Record<string, unknown>; tools: number; refusals: string[] };

/** The actions a tool's input takes: its `action` enum or const, or none for a tool with no action. */
function actionsOf(inputSchema: Record<string, unknown>): string[] {
  const action = (inputSchema.properties as Record<string, Record<string, unknown>> | undefined)
    ?.action;
  if (Array.isArray(action?.enum)) return action.enum.map(String);
  if (action?.const !== undefined) return [String(action.const)];
  return [];
}

/**
 * Each action's `x-forge-permission`, and a refusal for each action that declares none and is not
 * amnestied, or that the declaration names but the tool does not take.
 */
function permissionsOf(
  tool: ListedTool,
  amnestied: ReadonlySet<string>,
  declaresNone: Set<string>,
  refusals: string[],
): Record<string, unknown> {
  const actions = actionsOf(tool.inputSchema);
  const out: Record<string, unknown> = {};
  for (const action of actions) {
    const name = `${tool.name}.${action}`;
    const declared = toolPermissionFor(tool.permission, action);
    if (declared === undefined) declaresNone.add(name);
    else out[action] = renderedPermission(declared);
    const refused = undeclaredActionPermission(name, declared, amnestied);
    if (refused) refusals.push(refused);
  }
  if (tool.permission && 'byAction' in tool.permission) {
    for (const extra of Object.keys(tool.permission.byAction).filter((a) => !actions.includes(a))) {
      refusals.push(
        `${tool.name}.${extra}: declares a permission for an action the tool does not take`,
      );
    }
  }
  return out;
}

export function buildMcpContract(
  listing: ListedTool[],
  header: Record<string, unknown>,
  undeclaredActions: ReadonlySet<string> = UNDECLARED_PERMISSION_ACTIONS,
): McpContract {
  const refusals: string[] = [];
  const seen = new Set<string>();
  const declaresNone = new Set<string>();
  const permissions = new Map<string, Record<string, unknown>>();
  for (const tool of listing) {
    if (seen.has(tool.name)) refusals.push(`${tool.name}: listed twice by tools/list`);
    seen.add(tool.name);
    if (tool.inputSchema?.type !== 'object') {
      refusals.push(`${tool.name}: an inputSchema whose type is not "object", which MCP requires`);
    }
    // every action names the permission it needs (REQ-12 BC-20, ISS-824)
    permissions.set(tool.name, permissionsOf(tool, undeclaredActions, declaresNone, refusals));
  }
  refusals.push(...undeclaredPermissionAmnesties(undeclaredActions, declaresNone, 'actions'));
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
