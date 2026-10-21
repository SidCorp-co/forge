import type { ZodType } from 'zod';

/**
 * Which fields of a JSON body its schema does not take, so each is refused by name rather than
 * dropped, unless the schema says it takes any (`.loose()`, `.passthrough()`, `.catchall()`).
 */

type Def = {
  type: string;
  shape?: Record<string, unknown>;
  catchall?: ZodType;
  options?: ZodType[];
  discriminator?: string;
  innerType?: ZodType;
  in?: ZodType;
  out?: ZodType;
  left?: ZodType;
  right?: ZodType;
};

const defOf = (schema: ZodType): Def => (schema as unknown as { _zod: { def: Def } })._zod.def;

/** `.strict()` is a catchall of `never`, which takes no field; any other catchall takes them all. */
const takesAny = (def: Def): boolean => !!def.catchall && defOf(def.catchall).type !== 'never';

/** What a body schema says of a field it does not name: refused, taken, or not readable here. */
export type FieldsPolicy = 'closed' | 'open' | 'unread';

const WRAPPERS = new Set(['optional', 'nullable', 'default', 'prefault', 'readonly', 'catch']);

function unwrap(schema: ZodType): ZodType {
  let at = schema;
  for (;;) {
    const def = defOf(at);
    if (WRAPPERS.has(def.type) && def.innerType) at = def.innerType;
    // `z.preprocess` is a pipe from a transform: the body is read by the schema it hands on to.
    else if (def.type === 'pipe' && def.in)
      at = defOf(def.in).type === 'transform' && def.out ? def.out : def.in;
    else return at;
  }
}

/** The policy at a body schema's top level, read off its definition. */
export function fieldsPolicy(schema: ZodType): FieldsPolicy {
  const def = defOf(unwrap(schema));
  if (def.type === 'object') return takesAny(def) ? 'open' : 'closed';
  const parts =
    def.type === 'union'
      ? (def.options ?? [])
      : def.type === 'intersection' && def.left && def.right
        ? [def.left, def.right]
        : null;
  if (!parts || parts.length === 0) return 'unread';
  const each = parts.map(fieldsPolicy);
  if (each.includes('open')) return 'open';
  return each.every((p) => p === 'closed') ? 'closed' : 'unread';
}

function optionTakes(option: ZodType, discriminator: string, value: unknown): boolean {
  const own = (option as unknown as { _zod: { propValues?: Record<string, Set<unknown>> } })._zod;
  return own.propValues?.[discriminator]?.has(value) ?? false;
}

/** Every key a closed schema names for this body; null where a branch takes any key or none is chosen. */
function namedKeys(schema: ZodType, body: Record<string, unknown>): Set<string> | null {
  const def = defOf(unwrap(schema));
  if (def.type === 'object') return takesAny(def) ? null : new Set(Object.keys(def.shape ?? {}));
  let parts: ZodType[] = [];
  if (def.type === 'intersection' && def.left && def.right) parts = [def.left, def.right];
  else if (def.type === 'union' && def.options) {
    // A discriminated union names the keys of the option the body chose; a body choosing none is
    // refused by the schema itself, for its discriminator.
    const by = def.discriminator;
    parts = by ? def.options.filter((o) => optionTakes(o, by, body[by])) : def.options;
  }
  if (parts.length === 0) return null;
  const keys = new Set<string>();
  for (const part of parts) {
    const named = namedKeys(part, body);
    if (!named) return null;
    for (const k of named) keys.add(k);
  }
  return keys;
}

/** True where the schema's own `.strict()` names the stray fields, so they are not refused twice. */
export function refusesItself(schema: ZodType, body: unknown): boolean {
  const def = defOf(unwrap(schema));
  if (def.type === 'object') return !!def.catchall && defOf(def.catchall).type === 'never';
  if (def.type !== 'union' || !def.discriminator || !def.options) return false;
  if (body === null || typeof body !== 'object') return false;
  const by = def.discriminator;
  const chosen = def.options.filter((o) =>
    optionTakes(o, by, (body as Record<string, unknown>)[by]),
  );
  return chosen.length === 1 && refusesItself(chosen[0] as ZodType, body);
}

/** The fields of `body` its schema does not name, in the order they were sent. */
export function unknownFields(schema: ZodType, body: unknown): string[] {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) return [];
  const record = body as Record<string, unknown>;
  const named = namedKeys(schema, record);
  if (!named) return [];
  return Object.keys(record).filter((k) => !named.has(k));
}

/** The schemas a node stands for: itself unwrapped, and each branch of its unions and intersections. */
function branchesOf(schema: ZodType): ZodType[] {
  const at = unwrap(schema);
  const def = defOf(at) as Def & { getter?: () => ZodType };
  if (def.type === 'lazy' && def.getter) return branchesOf(def.getter());
  if (def.type === 'union') return (def.options ?? []).flatMap(branchesOf);
  if (def.type === 'intersection' && def.left && def.right)
    return [def.left, def.right].flatMap(branchesOf);
  return [at];
}

/** Every field the schema names at `path`, across every branch: what a stray field there may have meant. */
export function fieldsNamedAt(schema: ZodType, path: readonly PropertyKey[]): string[] {
  let nodes = branchesOf(schema);
  for (const segment of path) {
    nodes = nodes.flatMap((n) => {
      const def = defOf(n) as Def & { element?: ZodType };
      if (typeof segment === 'number') return def.element ? branchesOf(def.element) : [];
      const next = def.type === 'object' ? def.shape?.[String(segment)] : undefined;
      return next ? branchesOf(next as ZodType) : [];
    });
  }
  const names = nodes.flatMap((n) => {
    const def = defOf(n);
    return def.type === 'object' ? Object.keys(def.shape ?? {}) : [];
  });
  return [...new Set(names)];
}

/** A field inside a body object that the object does not take: where the object sits, and its keys. */
export type StrayAt = { path: PropertyKey[]; keys: string[] };

/** A node with its wrappers and any `z.lazy` taken off. */
function resolved(schema: ZodType): ZodType {
  let at = unwrap(schema);
  for (;;) {
    const def = defOf(at) as Def & { getter?: () => ZodType };
    if (def.type !== 'lazy' || !def.getter) return at;
    at = unwrap(def.getter());
  }
}

/** The schema a field of `body` is read by, or null where no one branch names it. */
function fieldSchema(schema: ZodType, body: Record<string, unknown>, key: string): ZodType | null {
  const def = defOf(resolved(schema));
  if (def.type === 'object') return (def.shape?.[key] as ZodType | undefined) ?? null;
  let parts: ZodType[] = [];
  if (def.type === 'intersection' && def.left && def.right) parts = [def.left, def.right];
  else if (def.type === 'union' && def.options) {
    const by = def.discriminator;
    parts = by ? def.options.filter((o) => optionTakes(o, by, body[by])) : def.options;
  }
  const found = parts.map((p) => fieldSchema(p, body, key)).filter((s): s is ZodType => !!s);
  return found.length === 1 ? (found[0] as ZodType) : null;
}

/** The strays inside a value its schema reads, at `path`. */
function straysIn(schema: ZodType, value: unknown, path: PropertyKey[]): StrayAt[] {
  const node = resolved(schema);
  const def = defOf(node) as Def & { element?: ZodType };
  if (Array.isArray(value)) {
    if (def.type !== 'array' || !def.element) return [];
    const element = def.element;
    return value.flatMap((v, i) => straysIn(element, v, [...path, i]));
  }
  if (value === null || typeof value !== 'object') return [];
  if (fieldsPolicy(node) !== 'closed') return [];
  // A strict object names its own strays, so they are not refused twice.
  const keys = refusesItself(node, value) ? [] : unknownFields(node, value);
  return [...(keys.length > 0 ? [{ path, keys }] : []), ...nestedStrays(node, value, path)];
}

/**
 * The fields inside a body's objects that those objects do not take, at any depth below the top
 * (ISS-1421 r20, judge-82's `provenance.colour`): a nested `z.object` drops one as silently as the
 * body's own does. An object that takes any field, or a record, holds none.
 */
export function nestedStrays(schema: ZodType, body: unknown, at: PropertyKey[] = []): StrayAt[] {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) return [];
  const record = body as Record<string, unknown>;
  return Object.keys(record).flatMap((key) => {
    const child = fieldSchema(schema, record, key);
    return child ? straysIn(child, record[key], [...at, key]) : [];
  });
}
