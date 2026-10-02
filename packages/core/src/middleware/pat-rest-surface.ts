import type { Context } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { matchedRoutes } from 'hono/route';
import { findTargetHandler, isMiddleware } from 'hono/utils/handler';
import {
  PAT_GRANT_EPOCH,
  PAT_PERMISSION_ALL,
  type PatPermission,
  type PatPermissionLevel,
  patGrantCovers,
  patGrantIsStatedFull,
  patPermissionPrefixes,
  patPermissionWanted,
  patPrefixForPath,
  patUngrantableFor,
} from '../auth/pat-permissions.js';
import type { PatScope } from '../auth/pat-scope.js';
import { patEffectiveProjectIds } from '../mcp/tools/project-scope.js';
import { authenticatePat, type PatPrincipal } from './require-pat.js';

export const PAT_ALLOWED_PREFIXES: readonly string[] = patPermissionPrefixes();

export const PAT_ACCEPTED_PERMISSIONS_HEADER = 'X-Accepted-Forge-Permissions';

export function patSurfaceCovers(path: string): boolean {
  return PAT_ALLOWED_PREFIXES.some((p) => path === p || path.startsWith(`${p}/`));
}

const PAT_REQUEST_VAR = 'patRequestResolution';

type PatRequestResolution = {
  token: string;
  principal: PatPrincipal;
  scope: PatScope;
};

// cm:why a gate mounted at a prefix runs for every path under it, served or not, so a token's grant would otherwise answer for a route nobody serves; a `use` entry is method ALL with a (c, next) middleware, anything else is a handler that answers
export function routeIsServed(c: Context): boolean {
  return matchedRoutes(c).some(
    (r) => r.method !== 'ALL' || !isMiddleware(findTargetHandler(r.handler)),
  );
}

const READ_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/** The PAT scope a request needs, from its method alone. */
export function scopeForMethod(method: string): 'read' | 'write' {
  return READ_METHODS.has(method.toUpperCase()) ? 'read' : 'write';
}

export function patHasScopeForMethod(principal: PatPrincipal, method: string): boolean {
  return principal.scopes.includes(scopeForMethod(method));
}

export async function beginPatRequest(
  c: Context,
  token: string,
): Promise<{ principal: PatPrincipal; scope: PatScope }> {
  const cached = c.get(PAT_REQUEST_VAR) as PatRequestResolution | undefined;
  if (cached && cached.token === token) return { principal: cached.principal, scope: cached.scope };

  const level = scopeForMethod(c.req.method);
  const excluded = patUngrantableFor(c.req.path, c.req.method);
  const wanted = excluded ? null : patPermissionWanted(c.req.path, level);
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
  if (!routeIsServed(c)) {
    throw new HTTPException(404, {
      message: `Not Found: ${c.req.method} ${c.req.path} — no route serves it, whatever the token holds`,
      cause: { code: 'NOT_FOUND' },
    });
  }
  if (excluded) {
    throw new HTTPException(403, {
      message:
        `${c.req.path} is kept out of what a personal or agent token can be granted ` +
        `(${excluded.pattern}): ${excluded.reason}. Use a session (browser/desktop login).`,
      cause: { code: 'PAT_NOT_PERMITTED', details: { excludedBy: excluded.pattern } },
    });
  }
  if (!patSurfaceCovers(c.req.path)) {
    throw new HTTPException(403, {
      message:
        'this route is not reachable with a personal access token — no permission on the menu ' +
        'covers it. Use a session (browser/desktop login).',
      cause: { code: 'PAT_NOT_PERMITTED' },
    });
  }
  if (!patHasScopeForMethod(principal, c.req.method)) {
    throw new HTTPException(403, {
      message: `this token lacks the '${level}' scope`,
      cause: { code: 'INSUFFICIENT_SCOPE' },
    });
  }
  const effectiveProjectIds = patEffectiveProjectIds(principal);
  assertReach(c.req.path, effectiveProjectIds);
  assertEpoch(principal, c.req.path);
  assertGranted(principal, c.req.path, level, wanted);
  const resolution: PatRequestResolution = {
    token,
    principal,
    scope: { projectIds: effectiveProjectIds, tokenId: principal.tokenId },
  };
  c.set(PAT_REQUEST_VAR, resolution);
  return { principal: resolution.principal, scope: resolution.scope };
}

/**
 * An account-reach route resolves no project, so a token fenced to projects
 * cannot be fenced on it: only a token carrying its owner's whole reach may.
 */
function assertReach(path: string, fence: readonly string[] | null): void {
  const match = patPrefixForPath(path);
  if (match?.reach !== 'account' || fence === null) return;
  throw new HTTPException(403, {
    message:
      `${path} is an account route under '${match.resource}', which resolves no project, and ` +
      'this token is fenced to projects. Use a token with no project list.',
    cause: { code: 'PAT_ACCOUNT_ROUTE', details: { resource: match.resource } },
  });
}

/** A token reaches a prefix only where the prefix joined the menu at or before its mint. */
function assertEpoch(principal: PatPrincipal, path: string): void {
  const match = patPrefixForPath(path);
  const held = principal.grantEpoch ?? 1;
  if (!match || match.epoch <= held) return;
  throw new HTTPException(403, {
    message:
      `${match.prefix} joined '${match.resource}' after this token was minted, and a token ` +
      'keeps the reach it was minted with. Mint a new token to reach it.',
    cause: {
      code: 'PAT_GRANT_PREDATES_ROUTE',
      details: { prefix: match.prefix, routeEpoch: match.epoch, tokenEpoch: held },
    },
  });
}

/** The PAT principal this request was admitted on, or null for any other door. */
export function patRequestPrincipal(c: Context): PatPrincipal | null {
  return (c.get(PAT_REQUEST_VAR) as PatRequestResolution | undefined)?.principal ?? null;
}

/**
 * A route that mints a `*` credential for another principal is refused to a
 * token granted less than `*`, which could otherwise mint itself a wider grant.
 */
export function assertMayMintFullCredential(c: Context): void {
  const principal = patRequestPrincipal(c);
  if (!principal || patGrantIsStatedFull(principal.permissions)) return;
  throw new HTTPException(403, {
    message:
      `${c.req.path} mints a credential granted '${PAT_PERMISSION_ALL}', and this token holds ` +
      `less: ${(principal.permissions ?? []).join(', ') || 'the legacy grant'}. Use a session, or ` +
      `a token granted '${PAT_PERMISSION_ALL}'.`,
    cause: { code: 'PAT_MINT_NEEDS_FULL_GRANT' },
  });
}

/**
 * The epoch a credential minted during this request is stamped with: the
 * admitting token's where a token admitted it, the menu's own for a session.
 */
export function mintEpochFor(c: Context): number {
  const principal = patRequestPrincipal(c);
  return principal ? Math.min(principal.grantEpoch ?? 1, PAT_GRANT_EPOCH) : PAT_GRANT_EPOCH;
}

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
      `Mint a token that includes it, or one granted '${PAT_PERMISSION_ALL}', ` +
      'which is full access chosen on purpose.',
    cause: { code: 'PAT_PERMISSION_REQUIRED', details: { wanted, held } },
  });
}
