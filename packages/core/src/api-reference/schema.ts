import { type ZodType, z } from 'zod';

/** JSON Schema as the reference writes it: draft 2020-12, which OpenAPI 3.1 reads as is. */
export type JsonSchema = Record<string, unknown>;

export type Rendered = {
  readonly schema: JsonSchema;
  /** Schemas the zod type named with `.meta({ id })`, lifted out for `components.schemas`. */
  readonly defs: Record<string, JsonSchema>;
  /** Where in the schema a type could not be represented, as `path:type`. Empty when it was whole. */
  readonly unrepresentable: readonly string[];
};

/** Types that add a rule to the type they wrap and render as what it renders: the inner one is judged. */
const WRAPPERS = new Set([
  'optional',
  'nullable',
  'default',
  'prefault',
  'readonly',
  'catch',
  'nonoptional',
]);

/**
 * A zod schema as JSON Schema, for what a client SENDS (`input`) or what it RECEIVES (`output`).
 *
 * A type JSON Schema cannot hold, a `transform` or a `custom` check, is reported by its path rather
 * than rendered as a schema that accepts anything: the library's own switch for that substitutes an
 * empty schema in silence, which is how a reference ends up promising nothing about a field.
 * A `Date` is a string on the wire, so it renders as `date-time`.
 */
export function renderSchema(schema: ZodType, io: 'input' | 'output'): Rendered {
  const unrepresentable: string[] = [];
  const raw = z.toJSONSchema(schema, {
    io,
    target: 'draft-2020-12',
    unrepresentable: 'any',
    override: ({ zodSchema, jsonSchema, path }) => {
      const type = (zodSchema as { _zod: { def: { type: string } } })._zod.def.type;
      if (type === 'date') {
        jsonSchema.type = 'string';
        jsonSchema.format = 'date-time';
        return;
      }
      if (WRAPPERS.has(type) || type === 'any' || type === 'unknown') return;
      if (Object.keys(jsonSchema).length === 0) unrepresentable.push(`${path.join('.')}:${type}`);
    },
  }) as JsonSchema;
  const {
    $schema: _dropped,
    $defs,
    ...schemaBody
  } = raw as JsonSchema & {
    $schema?: string;
    $defs?: Record<string, JsonSchema>;
  };
  const defs: Record<string, JsonSchema> = {};
  for (const [name, def] of Object.entries($defs ?? {})) defs[name] = toComponentRefs(def);
  return { schema: toComponentRefs(schemaBody), defs, unrepresentable };
}

const DEFS_PREFIX = '#/$defs/';
const COMPONENTS_PREFIX = '#/components/schemas/';

/** `#/$defs/X` is where the schema lifted a named type; the document keeps them in components. */
function toComponentRefs<T extends JsonSchema>(node: T): T {
  const walk = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(walk);
    if (value === null || typeof value !== 'object') return value;
    const out: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value)) {
      out[key] =
        key === '$ref' && typeof child === 'string' && child.startsWith(DEFS_PREFIX)
          ? `${COMPONENTS_PREFIX}${child.slice(DEFS_PREFIX.length)}`
          : walk(child);
    }
    return out;
  };
  return walk(node) as T;
}
