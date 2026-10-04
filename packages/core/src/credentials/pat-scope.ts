import { AsyncLocalStorage } from 'node:async_hooks';

export type PatScope = {
  readonly projectIds: readonly string[] | null;
  readonly tokenId: string;
  /** The token's holder, whose acts this request's token and delegation describe. */
  readonly userId?: string;
  readonly agency?: 'human' | 'agent';
  /** The person the token acts for (`personalAccessTokens.onBehalfOf`). */
  readonly onBehalfOf?: string | null;
  /** The token's grant: names, `['*']`, or null/empty for a token minted before grants. */
  readonly grant?: readonly string[] | null;
  readonly scopes?: readonly string[];
};

const storage = new AsyncLocalStorage<PatScope>();

export function runWithPatScope<T>(scope: PatScope, fn: () => T): T {
  return storage.run(scope, fn);
}

/** The fenced project ids, or `null` when this request is not scope-fenced. */
export function fencedProjectIds(): readonly string[] | null {
  return storage.getStore()?.projectIds ?? null;
}

/** The token this request arrived on, or null for a session. */
export function currentPatScope(): PatScope | null {
  return storage.getStore() ?? null;
}

export interface Delegation {
  readonly agency: 'human' | 'agent' | null;
  readonly tokenId: string | null;
  readonly onBehalfOf: string | null;
}

/**
 * The credential an act by `userId` arrives on in this request, and whom it acts for. Only the
 * request's own holder is answered: a check or a record about anyone else carries no token.
 */
export function delegationOf(userId: string | null | undefined): Delegation {
  const scope = storage.getStore();
  if (!scope || !userId || scope.userId !== userId) {
    return { agency: null, tokenId: null, onBehalfOf: null };
  }
  return {
    agency: scope.agency ?? null,
    tokenId: scope.tokenId,
    onBehalfOf: scope.onBehalfOf ?? null,
  };
}
