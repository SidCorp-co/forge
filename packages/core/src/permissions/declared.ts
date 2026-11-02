// The permission an action needs, declared once and enforced from that declaration by every door
// (REQ-12 BC-20, ISS-824). A REST route declares it where it is mounted (`requiresOnParam`, ...); an
// MCP tool declares it per action (`McpTool.permission`). The published contracts name it as
// `x-forge-permission`, and `enforceDeclared` is the one check both doors run before the handler:
// a project or organization named by a path parameter or a call argument is checked there; one the
// handler finds itself (from an issue, a body field) is declared `resolved`, and the handler checks
// the declared permission with `requireDeclared` once it has the access, never a permission it
// writes itself.

import { AsyncLocalStorage } from 'node:async_hooks';
import {
  ORG_PERMISSIONS,
  type OrgPermission,
  type ProjectPermission,
} from '@forge/contracts/permissions';
import type { MiddlewareHandler } from 'hono';
import type { OrgMemberRole } from '../db/schema.js';
import { loadOrgRole, loadProjectAccess } from '../lib/authz.js';
import { declaredInputOf, type McpTool } from '../lib/tool.js';
import {
  type DeclaredPermission,
  onResolved,
  permissionless,
  registerDeclaredPermission,
  toolPermissionFor,
} from '../middleware/declared-permission.js';
import { badRequest } from '../middleware/route-errors.js';
import { type PermissionFacts, requireHeld, requireOrgHeld } from './can.js';

export type {
  DeclaredPermission,
  PermissionlessAccess,
  PermissionOn,
  ToolPermission,
} from '../middleware/declared-permission.js';
export {
  declaredPermissions,
  onArg,
  onResolved,
  permissionless,
  toolPermissionFor,
} from '../middleware/declared-permission.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const isOrg = (p: ProjectPermission | OrgPermission): p is OrgPermission =>
  (ORG_PERMISSIONS as readonly string[]).includes(p);

/** The permission the running action declared, for its handler's `requireDeclared`. */
const inEffect = new AsyncLocalStorage<DeclaredPermission>();

/** The name a door gives the caller and reads a declaration's `param` or `arg` from. */
export type DeclaredCall = {
  userId: string | null;
  /** The id the declaration's `on` names, as the door holds it; undefined where it was not sent. */
  named: (on: { param: string } | { arg: string }) => unknown;
  /** `GET /api/x` or `forge_issues.create`, for a refusal or a wiring defect to name. */
  act: string;
};

/**
 * The one enforcement both doors run before an action's handler: a permission on a project or
 * organization the call names is checked here; one the handler resolves is held for its
 * `requireDeclared`; a permissionless declaration runs the handler as its credential gate admitted.
 */
export async function enforceDeclared<T>(
  declared: DeclaredPermission,
  call: DeclaredCall,
  run: () => Promise<T>,
): Promise<T> {
  if (declared.permission !== null && !('resolved' in declared.on)) {
    const id = call.named(declared.on);
    const where =
      'param' in declared.on
        ? `path parameter :${declared.on.param}`
        : `argument ${declared.on.arg}`;
    const what = isOrg(declared.permission) ? 'organization' : 'project';
    if (typeof id !== 'string' || id === '') {
      throw badRequest(
        `${call.act} needs ${declared.permission} on the ${what} its ${where} names, and none was sent`,
      );
    }
    // a call argument reaches here before the tool parses it; a route's parameter after its validator
    if ('arg' in declared.on && !UUID.test(id)) {
      throw badRequest(`${call.act}: ${declared.on.arg} names the ${what} by its uuid`);
    }
    if (isOrg(declared.permission)) {
      requireOrgHeld(id, await loadOrgRole(id, call.userId), declared.permission);
    } else {
      requireHeld(await loadProjectAccess(id, call.userId), declared.permission);
    }
  }
  return inEffect.run(declared, run);
}

function wiringDefect(what: string): Error {
  return new Error(
    `requireDeclared: ${what}; declare the permission where the action is mounted (requiresOnResolved for a route, onResolved in a tool's permission) (permissions/declared.ts)`,
  );
}

/** The resolved permission the running action declared, or a wiring defect naming what is missing. */
function resolvedInEffect(): ProjectPermission | OrgPermission {
  const declared = inEffect.getStore();
  if (!declared || declared.permission === null) {
    throw wiringDefect('the running action declares no permission for its handler to check');
  }
  return declared.permission;
}

/**
 * The action's declared project permission, held on `access`: a handler that finds its project
 * itself checks what its action declares, so the contract and the check cannot drift. Either door
 * reaches it, since a REST route and an MCP action calling one service each declare their own.
 */
export function requireDeclared(access: PermissionFacts, act?: string): void {
  const permission = resolvedInEffect();
  if (isOrg(permission))
    throw wiringDefect(
      `it declares ${permission}, an organization's, and the handler checks a project`,
    );
  requireHeld(access, permission, act);
}

/**
 * What a shared lookup checks on the project it resolves (an issue key, a row's id): the permission
 * the running action declares, or `fallback` for a caller that declares none yet. The fallback is
 * ISS-824's amnesty at a shared helper: it goes with the last undeclared caller.
 */
export function requireDeclaredOr(
  access: PermissionFacts,
  fallback: ProjectPermission,
  act?: string,
): void {
  const declared = inEffect.getStore();
  if (declared && declared.permission !== null && 'resolved' in declared.on) {
    requireDeclared(access, act);
    return;
  }
  requireHeld(access, fallback, act);
}

/** The action's declared organization permission, held on the org the handler found. */
export function requireDeclaredOrg(orgId: string, role: OrgMemberRole | null): void {
  const permission = resolvedInEffect();
  if (!isOrg(permission))
    throw wiringDefect(
      `it declares ${permission}, a project's, and the handler checks an organization`,
    );
  requireOrgHeld(orgId, role, permission);
}

// ---- the REST door: middleware mounted on the route, read by the contract generator ----

function mounted(declaration: DeclaredPermission): MiddlewareHandler {
  const mw: MiddlewareHandler = (c, next) =>
    enforceDeclared(
      declaration,
      {
        userId: (c.get('userId' as never) as string | undefined) ?? null,
        named: (on) => ('param' in on ? c.req.param(on.param) : undefined),
        act: `${c.req.method} ${c.req.routePath}`,
      },
      () => next(),
    );
  registerDeclaredPermission(mw, declaration);
  return mw;
}

/**
 * The route needs `permission` on the project (or, for an `org.*` permission, the organization)
 * its path parameter `param` names, checked before the handler runs. Mount it after the param
 * validator, so the id it reads is already a valid one.
 */
export function requiresOnParam(
  permission: ProjectPermission | OrgPermission,
  param = 'projectId',
): MiddlewareHandler {
  return mounted({ permission, on: { param } });
}

/**
 * The route needs `permission` on a project or organization its handler finds (`how`, as the
 * contract says it); the handler checks it with `requireDeclared` once it has the access.
 */
export function requiresOnResolved(
  permission: ProjectPermission | OrgPermission,
  how: string,
): MiddlewareHandler {
  return mounted(onResolved(permission, how));
}

/** The route needs no permission beyond its credential gate, for the reason `why`. */
export function requiresNoPermission(why: string): MiddlewareHandler {
  return mounted(permissionless('credential', why));
}

/** The route reads or writes only the caller's own rows, which its handler selects by the caller. */
export function requiresSelf(why: string): MiddlewareHandler {
  return mounted(permissionless('self', why));
}

/** The route answers anyone, with no credential. */
export function requiresPublic(why: string): MiddlewareHandler {
  return mounted(permissionless('public', why));
}

// ---- the tool door: /mcp and the chat assistant run a tool's action through the same check ----

/**
 * Runs a tool's action through what it declares, as `/mcp` and the chat assistant both do after the
 * token's grant is judged. An action that declares none runs as before: it is on the amnesty the
 * contract generator holds, and checks in its own handler until its module's sweep moves it.
 */
export function runDeclaredTool(
  tool: Pick<McpTool, 'name' | 'permission' | 'handler' | 'inputSchema'>,
  args: Record<string, unknown>,
  userId: string | null,
): Promise<unknown> {
  const declared = toolPermissionFor(tool.permission, args.action);
  if (declared === undefined) return tool.handler(args);
  // a call its own input refuses is answered by the tool's input gate, naming the wrong argument,
  // before any permission read: the handler parses that input first and does nothing else
  const input = declaredInputOf(tool.inputSchema);
  if (input && !input.safeParse(args).success) return tool.handler(args);
  return enforceDeclared(
    declared,
    {
      userId,
      named: (on) => ('arg' in on ? args[on.arg] : undefined),
      act: `${tool.name}${typeof args.action === 'string' ? `.${args.action}` : ''}`,
    },
    () => tool.handler(args),
  );
}
