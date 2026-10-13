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
