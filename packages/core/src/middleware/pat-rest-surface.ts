/**
 * Which REST paths a Personal Access Token may reach at all.
 *
 * The second half of the PAT fence. `lib/authz.ts` decides WHICH projects a
 * scoped token may name; this decides which routes are project-shaped enough
 * for that decision to mean anything. A route that never resolves a project
 * has nothing for the fence to bite on, so a PAT there would be an
 * account-scoped credential wearing a project-scoped label.
 *
 * The reachable set is no longer edited here: `auth/pat-permissions.ts`
 * declares the menu and {@link PAT_ALLOWED_PREFIXES} is its union, so a
 * token's reach widens by editing a named permission there, never this file.
 *
 * Three questions, not one, and {@link beginPatRequest} asks them in order —
 * the route's (is the path on the surface), the method's (does the scope word
 * admit it), the credential's (is the path in a group this token holds,
 * ISS-973); the union answers only the first. Before any of them it names the
 * permission wanted on {@link PAT_ACCEPTED_PERMISSIONS_HEADER}, from the one
 * resolution the grant check itself then consults (ISS-974).
 */

import type { Context } from 'hono';
import { HTTPException } from 'hono/http-exception';
import {
  type PatPermission,
  type PatPermissionLevel,
  patGrantCovers,
  patPermissionPrefixes,
  patPermissionWanted,
} from '../auth/pat-permissions.js';
import { type PatScope, runWithPatScope } from '../auth/pat-scope.js';
import { patEffectiveProjectIds } from '../mcp/tools/project-scope.js';
import { authenticatePat, type PatPrincipal } from './require-pat.js';

/**
 * Every prefix some permission covers, matched as a path prefix against
 * `/api/...` mounts in `index.ts`.
 *
 * Derived, never hand-kept: the declaration is `PAT_PERMISSION_RESOURCES`, and
 * a prefix reaches this array only by belonging to a named permission.
 */
// cm:edge contract -> packages/core/src/auth/pat-permissions.ts — to add or remove a reachable prefix, edit the resource map THERE. This is a computed union; a prefix appended here would be dropped on the next module load, and the `cm:guard`s that price the decision live on the declaration.
export const PAT_ALLOWED_PREFIXES: readonly string[] = patPermissionPrefixes();

/**
 * The permission a route required, told to the caller on the response.
 *
 * Named for GitHub's `X-Accepted-GitHub-Permissions`: a developer who has
 * integrated with fine-grained tokens already knows how to read it, and the
 * convention is worth more than a name of our own. The value is the Forge
 * permission NAME — `issues:write` — because its job is to be pasted into a
 * mint request, and the 403 body already spells it that way.
 */
// cm:edge contract -> packages/core/src/index.ts — listed in `corsMiddleware`'s `exposeHeaders` there, or a browser `fetch` cannot read it whatever the server sent. Same rule the `X-RateLimit-*` set is under, and the web UI is half of what reaches this surface.
export const PAT_ACCEPTED_PERMISSIONS_HEADER = 'X-Accepted-Forge-Permissions';

/**
 * Is this path on the PAT surface at all — for ANY token, however granted?
 *
 * `/api/pat` must never be reachable: a scoped token that can mint an
 * unscoped one has no scope. Called out by name because it is the one entry
 * whose absence collapses everything else, and it is absent by belonging to no
 * permission — `auth/pat-permissions.ts` is where that decision is priced.
 */
// cm:guard this answers the ROUTE's question and never the token's, which is why it was renamed off `patAllowedFor` in ISS-973 — a name promising "allowed" on a predicate that reads nothing off the principal is how the grant check gets skipped by someone who believes it already ran. The token's half is `patGrantCovers`, and `beginPatRequest` is the only place both are asked.
export function patSurfaceCovers(path: string): boolean {
  return PAT_ALLOWED_PREFIXES.some((p) => path === p || path.startsWith(`${p}/`));
}

/**
 * The token this request already resolved, so a second `beginPatRequest` on
 * the same request is free.
 *
 * Not an optimisation. Every router in this app self-gates with
 * `use('*', requireAuth(), …)` so it cannot be mounted unguarded, and Hono runs
 * the middleware of EVERY router whose prefix matches — nine of them on
 * `GET /api/projects/:id/issues`. Each one used to verify the token and charge
 * the rate-limit bucket again, so a token's real ceiling was its stated one
 * divided by however many routers happened to share a prefix, and an operator
 * reading `X-RateLimit-Limit: 600` was being refused after 66 requests.
 * Measured with `X-RateLimit-Remaining` on 2026-09-07: 9 per read request,
 * 3 per write (ISS-961).
 */
// cm:guard the memo is keyed on the TOKEN, not merely present, so a request that somehow carries two credentials re-verifies rather than inheriting the first one's principal. Every check `beginPatRequest` performs — the surface, the method's scope, the grant (ISS-973) — reads `c.req.path`, `c.req.method` or the token row itself, none of which can change within one request, so replaying the answer is sound; a check added here that reads anything else is not memoizable and must invalidate this.
// cm:guard the memo hit returns BEFORE the accepted-permissions header is set, and that is what keeps one value on a request nine routers match (ISS-974). `c.header` replaces rather than appends, so a second set would be harmless today — but only today: move the header below this return and a future `{ append: true }` would emit the name nine times with nothing going red.
const PAT_REQUEST_VAR = 'patRequestResolution';

type PatRequestResolution = {
  token: string;
  principal: PatPrincipal;
  scope: PatScope;
};

const READ_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/** The PAT scope a request needs, from its method alone. */
export function scopeForMethod(method: string): 'read' | 'write' {
  return READ_METHODS.has(method.toUpperCase()) ? 'read' : 'write';
}

export function patHasScopeForMethod(principal: PatPrincipal, method: string): boolean {
  return principal.scopes.includes(scopeForMethod(method));
}

/**
 * Everything that must be true before a PAT-authenticated request runs, and
 * the scope it must run inside.
 *
 * Both REST auth entrypoints call this: `requireAuth` (the data plane) and
 * `requireAnyAuth` (attachments and the two comment routes automation posts
 * to). Neither may reimplement it.
 */
// cm:guard ONE decision point for what a PAT may do, and `requireAnyAuth` is why it is a function rather than four lines copied twice. That middleware accepted PATs from the day it was written and fenced NOTHING — no allowlist, no project scope, `c.set('userId', verified.row.userId)` and straight through — so a token bound to one project read attachments and comments across every project its owner could see. It went unnoticed because the handlers behind it DO call loadProjectAccess and looked correct; what was missing was upstream of them. A second copy of this logic is how that returns.
export async function beginPatRequest(
  c: Context,
  token: string,
): Promise<{ principal: PatPrincipal; scope: PatScope }> {
  const cached = c.get(PAT_REQUEST_VAR) as PatRequestResolution | undefined;
  if (cached && cached.token === token) return { principal: cached.principal, scope: cached.scope };

  const level = scopeForMethod(c.req.method);
  // cm:guard resolved ONCE and handed to all three consumers — the response header, the grant check and the refusal's `details.wanted`. A second `patPermissionWanted` call on this path is a second derivation that can disagree with the fence, and every assertion about the header's value passes either way (ISS-974).
  const wanted = patPermissionWanted(c.req.path, level);
  // cm:guard handed to `authenticatePat` and fired by IT, at the instant `verifyPat` resolves — never called from here on a status this function caught. A 429 is today the only throw below that instant, but "the caller authenticated" is what earns the header and a status code is not that: an upstream throttle added above `verifyPat` would hand the permission map to callers who proved nothing (ISS-974). Set before the three checks, so the success path and every refusal carry one value from one call.
  const tellWhatTheRouteWanted = () => {
    if (wanted !== null) c.header(PAT_ACCEPTED_PERMISSIONS_HEADER, wanted);
  };
  const principal = await authenticatePat(c, token, level, tellWhatTheRouteWanted);
  if (!principal) {
    throw new HTTPException(401, {
      message: 'invalid token',
      cause: { code: 'INVALID_TOKEN' },
    });
  }
  // cm:guard verify the token BEFORE consulting the allowlist. Reversed, an unauthenticated caller reads the shape of the PAT surface off the status code — 403 where a route is allowlisted, 401 where it is not — which is a map of the fence handed out for free to anyone who can spell a path.
  if (!patSurfaceCovers(c.req.path)) {
    throw new HTTPException(403, {
      message:
        'this route is not reachable with a personal access token — it resolves no project, ' +
        'so a project-scoped token cannot be fenced on it. Use a session (browser/desktop login).',
      cause: { code: 'PAT_NOT_PERMITTED' },
    });
  }
  if (!patHasScopeForMethod(principal, c.req.method)) {
    throw new HTTPException(403, {
      message: `this token lacks the '${level}' scope`,
      cause: { code: 'INSUFFICIENT_SCOPE' },
    });
  }
  assertGranted(principal, c.req.path, level, wanted);
  const resolution: PatRequestResolution = {
    token,
    principal,
    scope: { projectIds: patEffectiveProjectIds(principal), tokenId: principal.tokenId },
  };
  c.set(PAT_REQUEST_VAR, resolution);
  return { principal: resolution.principal, scope: resolution.scope };
}

/**
 * The grant check, last of the three, so no refusal that existed before
 * ISS-973 changed its code or its message.
 */
// cm:guard the refusal NAMES the permission the path wanted and the ones the token holds, because the alternative an operator has is guessing which of fourteen names to add to a token they cannot see the reach of. A grant set is invisible from the caller's side; a 403 that only says "no" makes narrowing a token something nobody does twice.
// cm:guard `wanted` is the caller's to derive and this function's only to report — it is the same value the response header already carries, so `details.wanted` and the header cannot name different permissions. Resolving it here instead would put the second derivation back (ISS-974).
function assertGranted(
  principal: PatPrincipal,
  path: string,
  level: PatPermissionLevel,
  wanted: PatPermission | null,
): void {
  if (patGrantCovers(principal.permissions, wanted)) return;
  const held = principal.permissions ?? [];
  throw new HTTPException(403, {
    message:
      `this token was not granted '${wanted}', which is the permission ` +
      `${path} needs for a ${level} request. It holds: ${held.join(', ')}. ` +
      'Mint a token that includes it, or use one granted nothing, which reaches the whole menu.',
    cause: { code: 'PAT_PERMISSION_REQUIRED', details: { wanted, held } },
  });
}

/** Run `next()` inside the request's PAT scope. */
export function withPatScope<T>(scope: PatScope, next: () => T): T {
  return runWithPatScope(scope, next);
}
