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
