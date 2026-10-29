/**
 * A tool's input as `tools/list` hands it to a client: the JSON Schema the tool publishes, rewritten
 * into the plain subset every client's importer takes, with the same meaning.
 *
 * ChatGPT's connector authenticates, lists, and then reports "action discovery failed" with nothing
 * on the wire to say why (ISS-768 r2), and one schema a client's importer cannot read fails the whole
 * discovery, not the one tool. zod renders constructs such importers are known to refuse, so each is
 * rewritten into one they take:
 *
 * - a `$schema` is dropped; the listing is read as the protocol's own dialect;
 * - a `type` array becomes an `anyOf` of single types, each keyword that only applies to one type
 *   moved into that type's branch, and an object branch given `properties`;
 * - `propertyNames: { type: 'string' }` is dropped, since every JSON property name is a string;
 * - `const` becomes a one-value `enum` (a `default` beside it stays);
 * - `required` is an array of names, or absent where it names none;
 * - an object without `properties` gets an empty one;
 * - a `oneOf` stays where each branch is an object with properties, and becomes `anyOf` where its
 *   branches are of different single types, so no value can satisfy two of them.
 *
 * A construct that cannot be rewritten without changing what the tool accepts is refused by the
 * tool's name and the schema path when the registry is built, never listed loosened: the server
 * validates a call against the schema the tool published (`input-gate.ts`), and a listing that
 * accepted more would have a client send what the server then refuses.
 */

type Schema = Record<string, unknown>;

/** Keywords whose value is a map of names to schemas. */
const SCHEMA_MAPS = new Set(['properties', 'patternProperties', '$defs', 'definitions']);
/** Keywords whose value is one schema. */
const SCHEMA_ONE = new Set([
  'additionalProperties',
  'items',
  'not',
  'contains',
  'if',
  'then',
  'else',
  'unevaluatedProperties',
  'unevaluatedItems',
]);
/** Keywords whose value is a list of schemas. */
const SCHEMA_LISTS = new Set(['anyOf', 'allOf', 'oneOf', 'prefixItems']);

/** The keywords that constrain only an instance of one type, by that type. */
const TYPE_KEYWORDS: Record<string, readonly string[]> = {
  object: [
    'properties',
    'patternProperties',
    'additionalProperties',
    'required',
    'minProperties',
    'maxProperties',
    'unevaluatedProperties',
  ],
  array: ['items', 'prefixItems', 'minItems', 'maxItems', 'uniqueItems', 'contains'],
  string: ['minLength', 'maxLength', 'pattern', 'format'],
  number: ['minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum', 'multipleOf'],
  integer: ['minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum', 'multipleOf'],
};

/** The registry-build refusal for a construct the listing cannot rewrite with the same meaning. */
const unlistable = (tool: string, path: string, why: string) =>
  new Error(
    `mcp registry: ${tool}'s input at ${path || '/'} ${why}; tools/list cannot hand it to a client in the plain JSON Schema every importer reads without changing what the tool accepts (mcp/listed-schema.ts)`,
  );

const isPlain = (v: unknown): v is Schema =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** A `propertyNames` that admits every name: JSON property names are strings. */
const admitsEveryName = (v: unknown) =>
  v === true ||
  (isPlain(v) && Object.keys(v).length === 0) ||
  (isPlain(v) && Object.keys(v).length === 1 && v.type === 'string');

/** Two single types no one value can have both of (an integer is also a number). */
function disjointTypes(types: unknown[]): boolean {
  if (!types.every((t) => typeof t === 'string')) return false;
  const named = (types as string[]).map((t) => (t === 'integer' ? 'number' : t));
  return new Set(named).size === named.length;
}

/** `node` with each type-array split into an `anyOf` of single-type branches. */
function splitTypes(tool: string, path: string, node: Schema): Schema {
  const types = node.type;
  if (!Array.isArray(types)) return node;
  if (types.length === 1) return { ...node, type: types[0] };
  if ('anyOf' in node) {
    throw unlistable(tool, path, 'pairs a type list with an anyOf');
  }
  const { type: _, ...rest } = node;
  const parent: Schema = {};
  const branches: Schema[] = types.map((t) => ({ type: t }));
  for (const [k, v] of Object.entries(rest)) {
    const owners = types.filter((t) => TYPE_KEYWORDS[t as string]?.includes(k));
    if (owners.length === 0) {
      parent[k] = v;
      continue;
    }
    for (const branch of branches) if (owners.includes(branch.type)) branch[k] = v;
  }
  for (const branch of branches) {
    if (branch.type === 'object' && !('properties' in branch)) branch.properties = {};
  }
  return { ...parent, anyOf: branches };
}

function normalize(tool: string, path: string, node: unknown): unknown {
  if (typeof node === 'boolean') return node;
  if (!isPlain(node)) throw unlistable(tool, path, 'is not a JSON Schema');
  const out: Schema = {};
  for (const [k, v] of Object.entries(node)) {
    const at = `${path}/${k}`;
    if (k === '$schema') continue;
    if (k === 'propertyNames') {
      if (admitsEveryName(v)) continue;
      throw unlistable(tool, at, 'constrains property names beyond being strings');
    }
    if (k === 'required') {
      if (!Array.isArray(v) || !v.every((n) => typeof n === 'string')) {
        throw unlistable(tool, at, 'is not a list of property names');
      }
      if (v.length > 0) out.required = [...v];
      continue;
    }
    if (k === 'const') {
      if ('enum' in node) throw unlistable(tool, at, 'pairs a const with an enum');
      out.enum = [v];
      continue;
    }
    if (SCHEMA_MAPS.has(k)) {
      if (!isPlain(v)) throw unlistable(tool, at, 'is not a map of schemas');
      out[k] = Object.fromEntries(
        Object.entries(v).map(([name, s]) => [name, normalize(tool, `${at}/${name}`, s)]),
      );
      continue;
    }
    if (SCHEMA_ONE.has(k)) {
      out[k] = Array.isArray(v)
        ? v.map((s, i) => normalize(tool, `${at}/${i}`, s))
        : normalize(tool, at, v);
      continue;
    }
    if (SCHEMA_LISTS.has(k)) {
      if (!Array.isArray(v)) throw unlistable(tool, at, 'is not a list of schemas');
      out[k] = v.map((s, i) => normalize(tool, `${at}/${i}`, s));
      continue;
    }
    out[k] = v;
  }

  const split = splitTypes(tool, path, out);
  if (split.type === 'object' && !('properties' in split)) split.properties = {};

  if ('oneOf' in split) {
    const branches = split.oneOf as unknown[];
    const objects = branches.every(
      (b) => isPlain(b) && b.type === 'object' && isPlain(b.properties),
    );
    if (!objects) {
      const types = branches.map((b) => (isPlain(b) ? b.type : undefined));
      if (!disjointTypes(types) || 'anyOf' in split) {
        throw unlistable(
          tool,
          `${path}/oneOf`,
          'holds branches that are not objects and could match one value together',
        );
      }
      const { oneOf, ...rest } = split;
      return { ...rest, anyOf: oneOf };
    }
  }
  return split;
}

const listed = new WeakMap<object, Schema>();

/** `input` as `tools/list` hands it to a client; computed once per published schema. */
export function listedSchema(tool: string, input: Schema): Schema {
  const known = listed.get(input);
  if (known) return known;
  const out = normalize(tool, '', input) as Schema;
  listed.set(input, out);
  return out;
}
