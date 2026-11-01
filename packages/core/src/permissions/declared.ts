// The permission a route needs, declared where the route is mounted (REQ-12 BC-20, ISS-824): the
// published API names it as `x-forge-permission` on the operation, read off this middleware the way
// the auth gates and validators are read, and the request is checked against the same declaration.
// A route found on a project path parameter is checked here, before its handler; a route whose
// handler finds the project (from an issue, a body field) declares how, and its handler checks the
// declared permission with `requireDeclared`, never a permission written in handler code.

import type { ProjectPermission } from '@forge/contracts/permissions';
import type { Context, MiddlewareHandler } from 'hono';
import { loadProjectAccess } from '../lib/authz.js';
import {
  type DeclaredPermission,
  registerDeclaredPermission,
} from '../middleware/declared-permission.js';
import { type PermissionFacts, requireHeld } from './can.js';

export type { DeclaredPermission, PermissionOn } from '../middleware/declared-permission.js';
export { declaredPermissions } from '../middleware/declared-permission.js';

const HELD = 'declaredPermission' as never;

function register(declaration: DeclaredPermission, mw: MiddlewareHandler): MiddlewareHandler {
  registerDeclaredPermission(mw, declaration);
  return mw;
}

/**
 * The route needs `permission` on the project its path parameter `param` names, checked before the
 * handler runs. Mount it after the param validator, so the id it reads is already a valid one.
 */
export function requiresOnParam(
  permission: ProjectPermission,
  param = 'projectId',
): MiddlewareHandler {
  return register({ permission, on: { param } }, async (c, next) => {
    c.set(HELD, permission as never);
    const userId = (c.get('userId' as never) as string | undefined) ?? null;
    requireHeld(await loadProjectAccess(c.req.param(param) as string, userId), permission);
    await next();
  });
}

/**
 * The route needs `permission` on a project its handler finds (`how`, as the contract says it); the
 * handler checks it with `requireDeclared` once it has the project's access.
 */
export function requiresOnResolved(permission: ProjectPermission, how: string): MiddlewareHandler {
  return register({ permission, on: { resolved: how } }, async (c, next) => {
    c.set(HELD, permission as never);
    await next();
  });
}

/** The route needs no project permission beyond its credential gate, for the reason `why`. */
export function requiresNoPermission(why: string): MiddlewareHandler {
  return register({ permission: null, why }, async (_c, next) => {
    await next();
  });
}

/**
 * The route's declared permission, held on `access`: a handler that finds its project itself checks
 * what its route declares, so the contract and the check cannot drift. A route that declared none,
 * or declared none on a resolved project, is a wiring defect and throws naming it.
 */
export function requireDeclared(c: Context, access: PermissionFacts, act?: string): void {
  const permission = c.get(HELD) as ProjectPermission | undefined;
  if (!permission) {
    throw new Error(
      `requireDeclared: ${c.req.method} ${c.req.routePath} declares no permission; mount requiresOnResolved on it (permissions/declared.ts)`,
    );
  }
  requireHeld(access, permission, act);
}
