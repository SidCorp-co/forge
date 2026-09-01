/**
 * Which REST paths a Personal Access Token may reach at all.
 *
 * The second half of the PAT fence. `lib/authz.ts` decides WHICH projects a
 * scoped token may name; this decides which routes are project-shaped enough
 * for that decision to mean anything. A route that never resolves a project
 * has nothing for the fence to bite on, so a PAT there would be an
 * account-scoped credential wearing a project-scoped label.
 */

import type { Context } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { type PatScope, runWithPatScope } from '../auth/pat-scope.js';
import { patEffectiveProjectIds } from '../mcp/tools/project-scope.js';
import { authenticatePat, type PatPrincipal } from './require-pat-or-device.js';

/**
 * The project data plane, and nothing else. Matched as a path prefix against
 * `/api/...` mounts in `index.ts`.
 */
// cm:guard an ALLOWLIST, and it must stay one — a forgotten entry costs a caller a 403 they will report, while a forgotten entry on a deny-list is a silent leak nobody reports. Never invert this to "everything except", however much shorter that list looks: the routes that would need excluding are exactly the ones (`/api/pat`, `/api/orgs`, `/api/admin`, `/api/me`) where being wrong once ends the fence for good.
export const PAT_ALLOWED_PREFIXES: readonly string[] = [
  '/api/agent-sessions',
  '/api/attachments',
  '/api/comments',
  '/api/issue-step-contexts',
  '/api/issues',
  '/api/jobs',
  '/api/knowledge',
  '/api/knowledge-edges',
  '/api/labels',
  '/api/memory',
  '/api/pipeline-runs',
  '/api/projects',
  '/api/prompts',
  '/api/schedules',
  '/api/skill-facts',
  '/api/skills',
  '/api/tasks',
  '/api/uploads',
];

/**
 * `/api/pat` must never be reachable: a scoped token that can mint an
 * unscoped one has no scope. Called out by name because it is the one entry
 * whose absence from {@link PAT_ALLOWED_PREFIXES} collapses everything else,
 * and a prefix list is a weak place to record that.
 */
export function patAllowedFor(path: string): boolean {
  return PAT_ALLOWED_PREFIXES.some((p) => path === p || path.startsWith(`${p}/`));
}

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
  const principal = await authenticatePat(c, token);
  if (!principal) {
    throw new HTTPException(401, {
      message: 'invalid token',
      cause: { code: 'INVALID_TOKEN' },
    });
  }
  // cm:guard verify the token BEFORE consulting the allowlist. Reversed, an unauthenticated caller reads the shape of the PAT surface off the status code — 403 where a route is allowlisted, 401 where it is not — which is a map of the fence handed out for free to anyone who can spell a path.
  if (!patAllowedFor(c.req.path)) {
    throw new HTTPException(403, {
      message:
        'this route is not reachable with a personal access token — it resolves no project, ' +
        'so a project-scoped token cannot be fenced on it. Use a session (browser/desktop login).',
      cause: { code: 'PAT_NOT_PERMITTED' },
    });
  }
  if (!patHasScopeForMethod(principal, c.req.method)) {
    throw new HTTPException(403, {
      message: `this token lacks the '${scopeForMethod(c.req.method)}' scope`,
      cause: { code: 'INSUFFICIENT_SCOPE' },
    });
  }
  return {
    principal,
    scope: { projectIds: patEffectiveProjectIds(principal), tokenId: principal.tokenId },
  };
}

/** Run `next()` inside the request's PAT scope. */
export function withPatScope<T>(scope: PatScope, next: () => T): T {
  return runWithPatScope(scope, next);
}
