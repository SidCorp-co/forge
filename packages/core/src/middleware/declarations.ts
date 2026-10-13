/** One answer a gate can give instead of passing the request on. */
export type Refusal = {
  readonly status: number;
  readonly code: string;
  readonly when: string;
};

const refusals = new WeakMap<object, readonly Refusal[]>();

/**
 * Records the refusals a gate throws on the middleware it returned, so the API reference reads them
 * from the gate that throws them and not from a list kept beside it.
 */
export function refuses<M extends object>(middleware: M, thrown: readonly Refusal[]): M {
  refusals.set(middleware, Object.freeze([...thrown]));
  return middleware;
}

/** The refusals a gate declared, or none for a handler that declared nothing. */
export function refusalsOf(handler: object): readonly Refusal[] {
  return refusals.get(handler) ?? [];
}
