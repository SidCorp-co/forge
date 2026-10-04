import {
  PAT_GRANT_PREDATES_ROUTE,
  PAT_NESTED_SURFACES,
  PAT_PERMISSION_ALL,
  PAT_PERMISSION_GROUPS,
  PAT_PERMISSION_NAMES,
  type PatPermission,
  type PatRoute,
  patEpochRefusal,
  patGrantCovers,
  patPrefixForPath,
} from '../credentials/pat-permissions.js';
import type {
  ToolGrant,
  ToolGrantEntry,
  ToolGrantNone,
  ToolReach,
  ToolReachEntry,
  ToolRoute,
} from './tool.js';

export interface GrantedTool {
  readonly name: string;
  readonly inputSchema: Record<string, unknown>;
  readonly grant?: ToolGrant;
  readonly reach?: ToolReach;
  readonly route?: ToolRoute;
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

function permissionsOf(grant: ToolGrant | undefined): PatPermission[] {
  if (grant === undefined || grant === null) return [];
  const entries = hasByAction<ToolGrantEntry>(grant) ? Object.values(grant.byAction) : [grant];
  return entries.filter((e): e is PatPermission => typeof e === 'string');
}

function routesOf(route: ToolRoute | undefined): readonly string[] {
  if (route === undefined || route === null) return [];
  return typeof route === 'string' ? [route] : route;
}

function routeFor(tool: GrantedTool, permission: PatPermission): string | undefined {
  const { resource } = PAT_PERMISSION_GROUPS[permission];
  return routesOf(tool.route).find((r) => patPrefixForPath(r)?.resource === resource);
}

// cm:guard every permission a tool names is dated by a REST mount it declares under that
// permission's resource, so a tool cannot take an older epoch than the route serving its rows.
export function assertToolDeclaresRoute(tool: GrantedTool): void {
  const refuse = (why: string): never => {
    throw new Error(`MCP tool ${tool.name} is not registered: ${why}`);
  };
  const permissions = permissionsOf(tool.grant);
  const routes = routesOf(tool.route);
  if (permissions.length === 0) {
    if (routes.length > 0) refuse('it needs no grant, so no `route` dates it; drop the `route`');
    return;
  }
  if (routes.length === 0) {
    refuse(
      "it declares no `route`, the REST mount its work is served at (a menu prefix such as '/api/agent-sessions', one per resource its grants name), which dates it for the grant epoch",
    );
  }
  const byResource = new Map<string, string>();
  for (const route of routes) {
    const match = patPrefixForPath(route);
    if (!match || (match.prefix !== route && !(route in PAT_NESTED_SURFACES))) {
      refuse(`route '${route}' is neither a prefix on the menu nor a nested surface it dates`);
    }
    const resource = match?.resource ?? '';
    const taken = byResource.get(resource);
    if (taken) refuse(`routes '${taken}' and '${route}' are both under '${resource}'`);
    byResource.set(resource, route);
  }
  const named = new Set<string>();
  for (const permission of permissions) {
    const { resource } = PAT_PERMISSION_GROUPS[permission];
    if (!byResource.has(resource)) {
      refuse(`it is granted '${permission}', and no route it declares is under '${resource}'`);
    }
    named.add(resource);
  }
  for (const [resource, route] of byResource) {
    if (!named.has(resource)) {
      refuse(`route '${route}' is under '${resource}', which none of its grants names`);
    }
  }
}

export function assertToolDeclaresAccess(tool: GrantedTool): void {
  assertToolDeclaresGrant(tool);
  assertToolDeclaresReach(tool);
  assertToolDeclaresRoute(tool);
}

export function toolEpochRefusal(
  tool: GrantedTool,
  args: Record<string, unknown>,
  held: number | undefined,
): string | null {
  const action = calledAction(tool, args);
  const entry = pick(tool.grant, action);
  if (entry === undefined || isNone(entry)) return null;
  const what = hasByAction(tool.grant) ? `${tool.name} action '${action}'` : tool.name;
  const route = routeFor(tool, entry);
  if (route === undefined) {
    return `FORBIDDEN: ${what} needs '${entry}' and declares no route under its resource, so no token may call it`;
  }
  const refusal = patEpochRefusal(route, held);
  if (!refusal) return null;
  return `FORBIDDEN: ${PAT_GRANT_PREDATES_ROUTE}: ${what} is served at ${route}, and ${refusal.message} Nothing was done.`;
}
