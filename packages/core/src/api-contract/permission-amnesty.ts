// The routes still declaring no permission where they are mounted (REQ-12 BC-20, ISS-824), one
// priced amnesty for all of them. Each checks its permission in handler or service code, so it is
// guarded, but the published API cannot name what it needs and nothing holds the check and the
// contract together.
//
// Trades: these operations carry no `x-forge-permission`, and their check can drift from any reader's
// idea of it. Costs: an MCP or REST client reads their permission from prose or a refusal.
// Ends when: ISS-824's sweep has mounted a declaration on each, module by module; this list is then
// empty and both files go. The generator refuses a new route missing from it, and an entry naming a
// route that now declares one or is no longer mounted, so the list only shrinks.

import type { DeclaredPermission } from '../permissions/declared.js';
import amnesty from './permission-amnesty.json' with { type: 'json' };

/** Keyed `METHOD /path` as the router mounts it, the name every generator refusal uses. */
export const UNDECLARED_PERMISSION_ROUTES: ReadonlySet<string> = new Set(amnesty.routes);

/** The operation's `x-forge-permission`, and why it is refused where it carries more than one. */
export function permissionField(declared: readonly DeclaredPermission[]): {
  field: Record<string, unknown>;
  refusal: string | null;
} {
  const first = declared[0];
  return {
    field:
      first === undefined
        ? {}
        : {
            'x-forge-permission':
              first.permission === null
                ? { none: first.why }
                : { permission: first.permission, on: first.on },
          },
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
  return `${name}: declares no permission — mount requiresOnParam, requiresOnResolved or requiresNoPermission (permissions/declared.ts) on it`;
}

/** Entries naming a route that declares a permission now, or that is not mounted: each is refused. */
export function undeclaredPermissionAmnesties(
  amnestied: ReadonlySet<string>,
  declaresNone: ReadonlySet<string>,
): string[] {
  return [...amnestied]
    .filter((name) => !declaresNone.has(name))
    .map(
      (name) =>
        `${name}: listed in api-contract/permission-amnesty.json but declares a permission or is not mounted; remove the entry`,
    );
}
