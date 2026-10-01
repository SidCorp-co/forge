import {
  PAT_PERMISSION_ALL,
  PAT_PERMISSION_GROUPS,
  PAT_PERMISSION_NAMES,
  PAT_PERMISSION_RESOURCES,
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

/**
 * Where a tool's work lands. `project`: in one project, which the tool resolves and fences
 * itself. `public`: in no project and on nothing private, beside a `none` grant. `{ account }`:
 * beyond any one project, so a token fenced to projects is refused; the text names the work.
 */
export type ToolReachEntry = 'project' | 'public' | { readonly account: string };

export type ToolReach =
  | ToolReachEntry
  | { readonly byAction: Readonly<Record<string, ToolReachEntry>> };

export interface GrantedTool {
  readonly name: string;
  readonly inputSchema: Record<string, unknown>;
  readonly grant?: ToolGrant;
  readonly reach?: ToolReach;
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

function refuseUnmatchedActions(
  refuse: (why: string) => never,
  noun: 'grant' | 'reach',
  schemaActions: readonly string[] | null,
  declared: readonly string[],
): void {
  if (!schemaActions) {
    refuse(`it declares a ${noun} per action, and its schema takes no \`action\` enum`);
  }
  const actions = schemaActions ?? [];
  const missing = actions.filter((a) => !declared.includes(a));
  if (missing.length > 0) refuse(`actions ${missing.join(', ')} declare no ${noun}`);
  const extra = declared.filter((a) => !actions.includes(a));
  if (extra.length > 0)
    refuse(`it declares a ${noun} for ${extra.join(', ')}, which it does not take`);
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
    refuseUnmatchedActions(refuse, 'grant', actions, declared);
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
  const action = calledAction(tool, args);
  const entry = pick(grant, action);
  const byAction = hasByAction<ToolGrantEntry>(grant);
  if (entry === undefined) {
    const named = action === undefined ? 'a call naming no action' : `action '${action}'`;
    const declared = byAction ? Object.keys(grant.byAction).join(', ') : '';
    return `FORBIDDEN: ${tool.name} ${named} declares no grant, so it is refused. Declared actions: ${declared}`;
  }
  const what = byAction ? `${tool.name} action '${action}'` : tool.name;
  if (isNone(entry)) return null;
  if (patGrantCovers(granted, entry)) return null;
  return (
    `FORBIDDEN: ${what} needs '${entry}', and ${holder} was not granted it ` +
    `(it holds: ${(granted ?? []).join(', ')}). Nothing was done. Mint a token that includes ` +
    `'${entry}', or one granted '${PAT_PERMISSION_ALL}'.`
  );
}

function hasByAction<T>(value: unknown): value is { byAction: Readonly<Record<string, T>> } {
  return typeof value === 'object' && value !== null && 'byAction' in value;
}

function calledAction(tool: GrantedTool, args: Record<string, unknown>): string | undefined {
  if (typeof args.action === 'string') return args.action;
  const grant = tool.grant;
  return hasByAction<ToolGrantEntry>(grant)
    ? (grant as { defaultAction?: string }).defaultAction
    : undefined;
}

function pick<T>(
  declared: T | { byAction: Readonly<Record<string, T>> } | undefined,
  action: string | undefined,
): T | undefined {
  if (!hasByAction<T>(declared)) return declared;
  return action !== undefined && Object.hasOwn(declared.byAction, action)
    ? declared.byAction[action]
    : undefined;
}

function isAccount(entry: unknown): entry is { account: string } {
  return typeof entry === 'object' && entry !== null && 'account' in entry;
}

function reachProblem(entry: unknown, grant: ToolGrantEntry | undefined): string | null {
  if (entry === 'project') {
    if (typeof grant === 'string' && PAT_PERMISSION_GROUPS[grant]?.reach === 'account') {
      return `it is granted '${grant}', which resolves no project, so its reach is \`{ account }\`, not 'project'`;
    }
    return null;
  }
  if (entry === 'public') {
    return grant !== undefined && isNone(grant)
      ? null
      : "'public' is the reach of a call that needs no grant, and this one names a permission";
  }
  if (isAccount(entry)) {
    return typeof entry.account === 'string' && entry.account.trim() !== ''
      ? null
      : 'an `{ account }` reach names no work';
  }
  return "a reach is 'project', 'public' or `{ account: what }`";
}

// cm:guard every tool on the transport states whether its work belongs to one project, so a
// project-fenced token cannot reach account-wide work through a tool that never said.
export function assertToolDeclaresReach(tool: GrantedTool): void {
  const refuse = (why: string): never => {
    throw new Error(`MCP tool ${tool.name} is not registered: ${why}`);
  };
  const reach = tool.reach;
  if (reach === undefined || reach === null) {
    refuse(
      "it declares no `reach`, where its work lands ('project', 'public', `{ account: what }`, or `{ byAction }`)",
    );
  }
  const actions = actionEnum(tool.inputSchema);
  if (hasByAction<ToolReachEntry>(reach)) {
    refuseUnmatchedActions(refuse, 'reach', actions, Object.keys(reach.byAction));
    for (const [action, entry] of Object.entries(reach.byAction)) {
      const problem = reachProblem(entry, pick(tool.grant, action));
      if (problem) refuse(`action '${action}': ${problem}`);
    }
    return;
  }
  const grants = hasByAction<ToolGrantEntry>(tool.grant)
    ? Object.values(tool.grant.byAction)
    : [tool.grant];
  for (const grant of grants) {
    const problem = reachProblem(reach, grant);
    if (problem) refuse(problem);
  }
}

/** The work a call does beyond any one project, or null where it stays inside one. */
export function toolAccountWork(tool: GrantedTool, args: Record<string, unknown>): string | null {
  const entry = pick(tool.reach, calledAction(tool, args));
  if (!isAccount(entry)) return null;
  const action = hasByAction(tool.reach) ? ` action '${calledAction(tool, args)}'` : '';
  return `${tool.name}${action}, ${entry.account},`;
}

/** The grant epoch a permission joined the menu at: the earliest of its resource's prefixes. */
export function permissionEpoch(permission: PatPermission): number {
  const { resource } = PAT_PERMISSION_GROUPS[permission];
  return Math.min(...Object.values(PAT_PERMISSION_RESOURCES[resource].prefixes));
}

// cm:guard a token keeps the reach it was minted with on /mcp as on REST: a tool whose grant
// joined the menu after the token's epoch is refused, whatever the token was granted.
export function toolEpochRefusal(
  tool: GrantedTool,
  args: Record<string, unknown>,
  held: number,
): string | null {
  const action = calledAction(tool, args);
  const entry = pick(tool.grant, action);
  if (entry === undefined || isNone(entry)) return null;
  const epoch = permissionEpoch(entry);
  if (epoch <= held) return null;
  const what = hasByAction(tool.grant) ? `${tool.name} action '${action}'` : tool.name;
  return (
    `FORBIDDEN: PAT_GRANT_PREDATES_ROUTE: ${what} needs '${entry}', which joined the menu at ` +
    `grant epoch ${epoch}, after this token was minted (epoch ${held}), and a token keeps the ` +
    'reach it was minted with. Nothing was done. Mint a new token to reach it.'
  );
}
