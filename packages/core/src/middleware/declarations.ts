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

export function takesBearer(thrown: readonly Refusal[]): boolean {
  return thrown.some((r) => r.status === 401 && BEARER_REFUSALS.has(r.code));
}

const boxDoors = new WeakSet<object>();

/** Marks a gate that lets a paired box's device token through, so the routes behind it are known. */
export function letsBoxIn<M extends object>(middleware: M): M {
  boxDoors.add(middleware);
  return middleware;
}

export function admitsBox(handler: object): boolean {
  return boxDoors.has(handler);
}
