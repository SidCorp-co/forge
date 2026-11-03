// What both generated contracts publish of a declared permission, and the refusal each generator
// gives a route or a tool action that declares none (REQ-12 BC-20, ISS-824). There is no exception:
// an undeclared route or action stops `contracts:generate`, so the published contracts name the
// permission of every operation and every action they describe.

import { type DeclaredPermission, renderedPermission } from '../middleware/declared-permission.js';

/** The operation's `x-forge-permission`, and why it is refused where it carries more than one. */
export function permissionField(declared: readonly DeclaredPermission[]): {
  field: Record<string, unknown>;
  refusal: string | null;
} {
  const first = declared[0];
  return {
    field: first === undefined ? {} : { 'x-forge-permission': renderedPermission(first) },
    refusal:
      declared.length > 1
        ? 'two permission declarations, of which a request would be checked against both'
        : null,
  };
}

/** Why a route that declares no permission is refused, or null where it declares one. */
export function undeclaredPermission(
  name: string,
  declared: readonly DeclaredPermission[],
): string | null {
  if (declared.length > 0) return null;
  return `${name}: declares no permission — mount requiresOnParam, requiresOnResolved, requiresByRule, requiresInstanceAdmin, requiresSelf, requiresPublic or requiresNoPermission (permissions/declared.ts) on it`;
}

/** Why a tool action (or a tool that takes no action) that declares no permission is refused, or null. */
export function undeclaredActionPermission(
  name: string,
  declared: DeclaredPermission | undefined,
): string | null {
  if (declared !== undefined) return null;
  return `${name}: declares no permission — give the tool a \`permission\` naming it (onArg, onResolved, byRule, instanceAdmin or permissionless, middleware/declared-permission.ts)`;
}
