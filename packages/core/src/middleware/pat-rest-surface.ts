/**
 * Which REST paths a Personal Access Token may reach at all.
 *
 * The second half of the PAT fence. `lib/authz.ts` decides WHICH projects a
 * scoped token may name; this decides which routes are project-shaped enough
 * for that decision to mean anything. A route that never resolves a project
 * has nothing for the fence to bite on, so a PAT there would be an
 * account-scoped credential wearing a project-scoped label.
 */

import type { PatPrincipal } from './require-pat-or-device.js';

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
