// What a route declares it needs, held where the published API reads it (ISS-824). The registry sits
// beside the auth gates' (`declared-gate.ts`) so the contract generator reads both off the mounted
// handler without reaching into the permissions module; `permissions/declared.ts` registers here.

import type { ProjectPermission } from '@forge/contracts/permissions';

/** Where the project a declared permission is held on is found. */
export type PermissionOn =
  /** The path parameter that names the project. */
  | { param: string }
  /** The handler finds it, as this says (`the issue's project`); it checks with requireDeclared. */
  | { resolved: string };

export type DeclaredPermission =
  | { permission: ProjectPermission; on: PermissionOn }
  /** No project permission: the route's credential gate is the whole check, for the reason given. */
  | { permission: null; why: string };

const declared = new WeakMap<object, DeclaredPermission>();

/** What the API contract reads off a mounted handler. */
export const declaredPermissions: Pick<WeakMap<object, DeclaredPermission>, 'get'> = declared;

/** Records what a mounted middleware declares; only `permissions/declared.ts` writes here. */
export function registerDeclaredPermission(handler: object, declaration: DeclaredPermission): void {
  declared.set(handler, declaration);
}
