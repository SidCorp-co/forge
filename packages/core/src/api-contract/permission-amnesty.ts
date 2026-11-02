// The REST routes and MCP tool actions still declaring no permission (REQ-12 BC-20, ISS-824), one
// priced amnesty for all of them. Each checks its permission in handler or service code, so it is
// guarded, but the published contracts cannot name what it needs and nothing holds the check and
// the contract together.
//
// Trades: these operations and actions carry no `x-forge-permission`, and their check can drift from
// any reader's idea of it. Costs: an MCP or REST client reads their permission from prose or a
// refusal. Ends when: ISS-824's sweep has declared each, module by module; both lists are then empty
// and both files go. The generator refuses a new route or action missing from it, and an entry
// naming one that now declares a permission or is no longer served, so the lists only shrink.

import { type DeclaredPermission, renderedPermission } from '../middleware/declared-permission.js';
import amnesty from './permission-amnesty.json' with { type: 'json' };

/** Keyed `METHOD /path` as the router mounts it, the name every generator refusal uses. */
export const UNDECLARED_PERMISSION_ROUTES: ReadonlySet<string> = new Set(amnesty.routes);

/** Keyed `<tool>.<action>`, as the MCP contract names an action. */
export const UNDECLARED_PERMISSION_ACTIONS: ReadonlySet<string> = new Set(amnesty.actions);

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

/** Why a route that declares no permission is refused, or null where it declares one or is amnestied. */
export function undeclaredPermission(
  name: string,
  declared: readonly DeclaredPermission[],
  amnestied: ReadonlySet<string>,
): string | null {
  if (declared.length > 0 || amnestied.has(name)) return null;
  return `${name}: declares no permission — mount requiresOnParam, requiresOnResolved, requiresByRule, requiresInstanceAdmin, requiresSelf, requiresPublic or requiresNoPermission (permissions/declared.ts) on it`;
}

/** Why a tool action that declares no permission is refused, or null where it declares one or is amnestied. */
export function undeclaredActionPermission(
  name: string,
  declared: DeclaredPermission | undefined,
  amnestied: ReadonlySet<string>,
): string | null {
  if (declared !== undefined || amnestied.has(name)) return null;
  return `${name}: declares no permission — give the tool a \`permission\` naming it (onArg, onResolved, byRule, instanceAdmin or permissionless, middleware/declared-permission.ts)`;
}

/** Entries naming a route or action that declares a permission now, or that is not served: each is refused. */
export function undeclaredPermissionAmnesties(
  amnestied: ReadonlySet<string>,
  declaresNone: ReadonlySet<string>,
  list: 'routes' | 'actions' = 'routes',
): string[] {
  return [...amnestied]
    .filter((name) => !declaresNone.has(name))
    .map(
      (name) =>
        `${name}: listed under ${list} in api-contract/permission-amnesty.json but declares a permission or is not ${list === 'routes' ? 'mounted' : 'served'}; remove the entry`,
    );
}
