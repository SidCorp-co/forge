import type { Context } from 'hono';
import { HTTPException } from 'hono/http-exception';
import {
  type PatPermission,
  type PatPermissionLevel,
  patGrantCovers,
  patPermissionPrefixes,
  patPermissionWanted,
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
  const wanted = patPermissionWanted(c.req.path, level);
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
