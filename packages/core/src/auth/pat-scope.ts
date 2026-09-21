import { AsyncLocalStorage } from 'node:async_hooks';

export type PatScope = {
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
