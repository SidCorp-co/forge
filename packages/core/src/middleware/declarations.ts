export type Refusal = {
  readonly status: number;
  readonly code: string;
  readonly when: string;
};

const refusals = new WeakMap<object, readonly Refusal[]>();

/** Records the refusals a gate throws on the middleware it returned, for the API reference. */
export function refuses<M extends object>(middleware: M, thrown: readonly Refusal[]): M {
  refusals.set(middleware, Object.freeze([...thrown]));
  return middleware;
}

export function refusalsOf(handler: object): readonly Refusal[] {
  return refusals.get(handler) ?? [];
}

/** The codes a gate throws when a bearer credential is missing or does not verify. */
const BEARER_REFUSALS: ReadonlySet<string> = new Set(['UNAUTHENTICATED', 'INVALID_TOKEN']);

/** Whether a route's gates turn a missing or invalid bearer away, which is what reading one means. */
export function takesBearer(thrown: readonly Refusal[]): boolean {
  return thrown.some((r) => r.status === 401 && BEARER_REFUSALS.has(r.code));
}
