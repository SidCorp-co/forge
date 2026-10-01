import {
  PAT_PERMISSION_ALL,
  PAT_PERMISSION_NAMES,
  type PatPermission,
  patGrantCovers,
} from '../auth/pat-permissions.js';

export type ToolGrantNone = { readonly none: string };

export type ToolGrantEntry = PatPermission | ToolGrantNone;

// cm:guard an action the per-action table does not name is refused, never let through.
export type ToolGrant =
  | ToolGrantEntry
  | {
      readonly byAction: Readonly<Record<string, ToolGrantEntry>>;
      readonly defaultAction?: string;
    };

export interface GrantedTool {
  readonly name: string;
  readonly inputSchema: Record<string, unknown>;
  readonly grant?: ToolGrant;
}

const MENU: ReadonlySet<string> = new Set(PAT_PERMISSION_NAMES);

function isNone(entry: ToolGrantEntry): entry is ToolGrantNone {
  return typeof entry === 'object' && entry !== null && 'none' in entry;
}

function entryProblem(entry: unknown): string | null {
  if (typeof entry === 'string') {
    return MENU.has(entry) ? null : `'${entry}' is not a permission on the menu`;
  }
  if (entry && typeof entry === 'object' && 'none' in entry) {
    const reason = (entry as { none: unknown }).none;
    return typeof reason === 'string' && reason.trim() !== ''
      ? null
      : 'a `none` entry carries no reason';
  }
  return 'an entry is neither a menu permission nor `{ none: reason }`';
}

function actionEnum(schema: Record<string, unknown>): readonly string[] | null {
  const props = schema.properties as Record<string, { enum?: unknown }> | undefined;
  const values = props?.action?.enum;
  return Array.isArray(values) ? (values as string[]) : null;
}

// cm:guard the per-action table must name exactly the schema's `action` enum, so an action added
// to a tool cannot reach the transport undeclared.
export function assertToolDeclaresGrant(tool: GrantedTool): void {
  const refuse = (why: string): never => {
    throw new Error(`MCP tool ${tool.name} is not registered: ${why}`);
  };
  const grant = tool.grant;
  if (grant === undefined || grant === null) {
    refuse(
      "it declares no `grant`, the permission a token must hold to call it (a menu name such as 'issues:read', `{ byAction }`, or `{ none: reason }`)",
    );
  }
  const actions = actionEnum(tool.inputSchema);
  if (typeof grant === 'object' && grant !== null && 'byAction' in grant) {
    const declared = Object.keys(grant.byAction);
    for (const [action, entry] of Object.entries(grant.byAction)) {
      const problem = entryProblem(entry);
      if (problem) refuse(`action '${action}': ${problem}`);
    }
    if (!actions) refuse('it declares a grant per action, and its schema takes no `action` enum');
    const missing = (actions ?? []).filter((a) => !declared.includes(a));
    if (missing.length > 0) refuse(`actions ${missing.join(', ')} declare no grant`);
    const extra = declared.filter((a) => !(actions ?? []).includes(a));
    if (extra.length > 0)
      refuse(`it declares a grant for ${extra.join(', ')}, which it does not take`);
    if (grant.defaultAction !== undefined && !declared.includes(grant.defaultAction)) {
      refuse(`its default action '${grant.defaultAction}' declares no grant`);
    }
    return;
  }
  const problem = entryProblem(grant);
  if (problem) refuse(problem);
}

export function toolGrantRefusal(
  tool: GrantedTool,
  args: Record<string, unknown>,
  granted: readonly string[] | null | undefined,
  holder = 'this token',
): string | null {
  const grant = tool.grant;
  if (grant === undefined || grant === null) {
    return `FORBIDDEN: ${tool.name} declares no grant, so no token may call it`;
  }
  let entry: ToolGrantEntry;
  let what = tool.name;
  if (typeof grant === 'object' && 'byAction' in grant) {
    const action = typeof args.action === 'string' ? args.action : grant.defaultAction;
    const found =
      action !== undefined && Object.hasOwn(grant.byAction, action)
        ? grant.byAction[action]
        : undefined;
    if (found === undefined) {
      const named = action === undefined ? 'a call naming no action' : `action '${action}'`;
      return `FORBIDDEN: ${tool.name} ${named} declares no grant, so it is refused. Declared actions: ${Object.keys(grant.byAction).join(', ')}`;
    }
    entry = found;
    what = `${tool.name} action '${action}'`;
  } else {
    entry = grant;
  }
  if (isNone(entry)) return null;
  if (patGrantCovers(granted, entry)) return null;
  return (
    `FORBIDDEN: ${what} needs '${entry}', and ${holder} was not granted it ` +
    `(it holds: ${(granted ?? []).join(', ')}). Nothing was done. Mint a token that includes ` +
    `'${entry}', or one granted '${PAT_PERMISSION_ALL}'.`
  );
}
