/**
 * The request-scoped project fence for a PAT-authenticated REST call.
 *
 * `middleware/auth.ts` puts the token's effective project allowlist here and
 * runs the rest of the request inside it; `lib/authz.ts` reads it back out.
 * The indirection is the whole point: every project permission decision in
 * core already funnels through `effectiveProjectRole`, so one read there
 * fences 228 call sites without any of them changing.
 */

import { AsyncLocalStorage } from 'node:async_hooks';

export type PatScope = {
  /** Projects this token may speak for. `null` = user-level, unfenced. */
  readonly projectIds: readonly string[] | null;
  readonly tokenId: string;
};

const storage = new AsyncLocalStorage<PatScope>();

export function runWithPatScope<T>(scope: PatScope, fn: () => T): T {
  return storage.run(scope, fn);
}

/** The fenced project ids, or `null` when this request is not scope-fenced. */
export function fencedProjectIds(): readonly string[] | null {
  return storage.getStore()?.projectIds ?? null;
}
