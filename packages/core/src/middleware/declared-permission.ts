// What an action declares it needs (REQ-12 BC-20, ISS-824): a REST route where it is mounted, an MCP
// tool per action. Held where the published API reads it: the registry sits beside the auth gates'
// (`declared-gate.ts`) so the contract generator reads both off the mounted handler without reaching
// into the permissions module; `permissions/declared.ts` registers here and enforces.

import type { OrgPermission, ProjectPermission } from '@forge/contracts/permissions';

/** Where the project or organization a declared permission is held on is found. */
export type PermissionOn =
  /** The REST path parameter that names it. */
  | { param: string }
  /** The MCP call argument that names it. */
  | { arg: string }
  /** The handler finds it, as this says (`the issue's project`); it checks with requireDeclared. */
  | { resolved: string };

/**
 * Who may call an action that needs no project or organization permission:
 * - `public`: anyone, with no credential (a liveness probe, the published contract, a guide);
 * - `credential`: whoever the route's credential gate admits, that gate being the whole check (a
 *   platform administrator, a paired box, a running job's token);
 * - `self`: any signed-in caller, on rows that are the caller's own; the handler reads only those,
 *   which is a data rule, not a permission.
 */
export type PermissionlessAccess = 'public' | 'credential' | 'self';

export type DeclaredPermission =
  /** A project permission, or an organization's (`org.*`), held on the project or org `on` names. */
  | { permission: ProjectPermission | OrgPermission; on: PermissionOn }
  | { permission: null; access: PermissionlessAccess; why: string };

/** A declaration written as data, for a door that is not middleware (an MCP tool's action). */
export const onArg = (
  permission: ProjectPermission | OrgPermission,
  arg = 'projectId',
): DeclaredPermission => ({ permission, on: { arg } });

export const onResolved = (
  permission: ProjectPermission | OrgPermission,
  how: string,
): DeclaredPermission => ({ permission, on: { resolved: how } });

export const permissionless = (access: PermissionlessAccess, why: string): DeclaredPermission => ({
  permission: null,
  access,
  why,
});

const RENDERED_ACCESS: Record<PermissionlessAccess, string> = {
  credential: 'none',
  self: 'self',
  public: 'public',
};

/**
 * How the published contracts name a declaration: `x-forge-permission` on a route or an action,
 * `{ permission, on }`, or `{ none | self | public: why }` for an action that needs no permission.
 */
export function renderedPermission(declared: DeclaredPermission): Record<string, unknown> {
  return declared.permission === null
    ? { [RENDERED_ACCESS[declared.access]]: declared.why }
    : { permission: declared.permission, on: declared.on };
}

/**
 * The permission each of an MCP tool's actions needs: one declaration for the tool or one per
 * action, enforced before the handler by every door that serves the tool and published per action
 * in the MCP contract. Distinct from a tool's `grant`, which is what a token must have been granted;
 * this is what its holder must hold.
 */
export type ToolPermission =
  | DeclaredPermission
  | { readonly byAction: Readonly<Record<string, DeclaredPermission>> };

/** What a tool's action declares, or undefined where it declares none (an amnestied action). */
export function toolPermissionFor(
  declaredFor: ToolPermission | undefined,
  action: unknown,
): DeclaredPermission | undefined {
  if (declaredFor === undefined) return undefined;
  if (!('byAction' in declaredFor)) return declaredFor;
  return typeof action === 'string' && Object.hasOwn(declaredFor.byAction, action)
    ? declaredFor.byAction[action]
    : undefined;
}

const declared = new WeakMap<object, DeclaredPermission>();

/** What the API contract reads off a mounted handler. */
export const declaredPermissions: Pick<WeakMap<object, DeclaredPermission>, 'get'> = declared;

/** Records what a mounted middleware declares; only `permissions/declared.ts` writes here. */
export function registerDeclaredPermission(handler: object, declaration: DeclaredPermission): void {
  declared.set(handler, declaration);
}
