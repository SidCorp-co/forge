import { COMPOSED_HANDLER } from 'hono/utils/constants';
import { z } from 'zod';
import { type DeclaredInput, declaredInputs } from '../middleware/zod-validator.js';

export type MountedRoute = { method: string; path: string; handler: unknown };

type JsonSchema = Record<string, unknown>;
type Operation = Record<string, unknown>;

export type ApiContract = { document: JsonSchema; operations: number; refusals: string[] };

export const UNDECLARED_RESPONSE =
  'Undeclared. forge-core holds no response schema for this route, so this contract does not describe what it answers.';

const INPUT_TARGETS = ['json', 'param', 'query'] as const;
type InputTarget = (typeof INPUT_TARGETS)[number];

const METHOD_ORDER = ['GET', 'PUT', 'POST', 'DELETE', 'OPTIONS', 'HEAD', 'PATCH', 'TRACE'];

function unwrap(handler: unknown): unknown {
  let current = handler;
  while (typeof current === 'function' && COMPOSED_HANDLER in current) {
    current = (current as unknown as Record<string, unknown>)[COMPOSED_HANDLER];
  }
  return current;
}

function inputOf(handler: unknown): DeclaredInput | undefined {
  const inner = unwrap(handler);
  return typeof inner === 'function' ? declaredInputs.get(inner) : undefined;
}

function segmentsOf(path: string): string[] {
  return path.split('/').filter((s) => s.length > 0);
}

function middlewareCovers(pattern: string, path: string): boolean {
  const want = segmentsOf(pattern);
  const have = segmentsOf(path);
  for (const [i, segment] of want.entries()) {
    if (i === want.length - 1 && segment.endsWith('*')) {
      return have.slice(i).join('/').startsWith(segment.slice(0, -1));
    }
    const actual = have[i];
    if (actual === undefined) return false;
    if (!segment.startsWith(':') && segment !== actual) return false;
  }
  return want.length === have.length;
}

type PathShape = { template: string; params: { name: string; pattern?: string }[] };

function pathShape(path: string): PathShape | string {
  const params: PathShape['params'] = [];
  const out: string[] = [];
  for (const segment of segmentsOf(path)) {
    if (segment.includes('*')) return 'a wildcard segment, which an OpenAPI path cannot express';
    if (!segment.startsWith(':')) {
      out.push(segment);
      continue;
    }
    const m = segment.match(/^:([A-Za-z0-9_]+)(?:\{(.+)\})?(\?)?$/);
    const name = m?.[1];
    if (m === null || name === undefined) {
      return `the path segment \`${segment}\`, which this generator cannot read`;
    }
    if (m[3] === '?') {
      return `the optional parameter \`${segment}\`, which an OpenAPI path cannot express`;
    }
    const regex = m[2];
    params.push(regex === undefined ? { name } : { name, pattern: `^${regex}$` });
    out.push(`{${name}}`);
  }
  return { template: `/${out.join('/')}`, params };
}

const UNREPRESENTABLE = new Set([
  'bigint',
  'custom',
  'date',
  'function',
  'map',
  'nan',
  'promise',
  'set',
  'symbol',
  'transform',
  'undefined',
  'void',
]);

// cm:why zod describes a coerced input by the type it coerces to (z.coerce.number() is
// `number`), so a coerced date is the string form JSON and a URL can carry; every other type
// z.toJSONSchema cannot represent is refused rather than widened to `{}`.
function jsonSchemaOf(input: DeclaredInput): JsonSchema | string {
  if (!('_zod' in input.schema))
    return 'a schema that is not zod 4, which z.toJSONSchema cannot read';
  const unrepresentable = new Set<string>();
  const { $schema: _dialect, ...schema } = z.toJSONSchema(input.schema, {
    io: 'input',
    unrepresentable: 'any',
    override: (ctx) => {
      const def = ctx.zodSchema._zod.def as { type: string; coerce?: boolean };
      if (def.type === 'date' && def.coerce === true) {
        ctx.jsonSchema.type = 'string';
        ctx.jsonSchema.format = 'date-time';
      } else if (UNREPRESENTABLE.has(def.type)) {
        unrepresentable.add(def.type);
      }
    },
  }) as JsonSchema;
  if (unrepresentable.size > 0) {
    return `a schema holding ${[...unrepresentable]
      .sort()
      .map((t) => `z.${t}()`)
      .join(', ')}, which JSON Schema cannot represent`;
  }
  if ('$defs' in schema)
    return 'a schema carrying $defs, whose references this generator does not hoist';
  return schema;
}

function objectProperties(
  schema: JsonSchema,
): { properties: Record<string, JsonSchema>; required: Set<string> } | null {
  if (
    schema.type !== 'object' ||
    typeof schema.properties !== 'object' ||
    schema.properties === null
  ) {
    return null;
  }
  const required = Array.isArray(schema.required) ? (schema.required as string[]) : [];
  return {
    properties: schema.properties as Record<string, JsonSchema>,
    required: new Set(required),
  };
}

type Described = { operation: Operation; refusals: string[] };

function pathParameters(shape: PathShape, schema: JsonSchema | undefined, refusals: string[]) {
  const declared = schema === undefined ? null : objectProperties(schema);
  if (schema !== undefined && declared === null)
    refusals.push('a param validator whose schema is not an object');
  const names = new Set(shape.params.map((p) => p.name));
  for (const key of Object.keys(declared?.properties ?? {})) {
    if (!names.has(key))
      refusals.push(`a param validator for \`${key}\`, which the path does not carry`);
  }
  return shape.params.map((p) => {
    const base = declared?.properties[p.name] ?? { type: 'string' };
    return {
      in: 'path',
      name: p.name,
      required: true,
      schema: p.pattern === undefined ? base : { ...base, pattern: p.pattern },
    };
  });
}

function queryParameters(schema: JsonSchema, refusals: string[]) {
  const declared = objectProperties(schema);
  if (declared === null) {
    refusals.push('a query validator whose schema is not an object, so it names no parameters');
    return [];
  }
  return Object.entries(declared.properties).map(([name, property]) => ({
    in: 'query',
    name,
    required: declared.required.has(name),
    schema: property,
  }));
}

function describe(shape: PathShape, inputs: DeclaredInput[]): Described {
  const refusals: string[] = [];
  const schemas = new Map<InputTarget, JsonSchema>();
  for (const input of inputs) {
    const target = input.target as string;
    if (!(INPUT_TARGETS as readonly string[]).includes(target)) {
      refusals.push(
        `a validator for \`${target}\`, a request part this generator does not describe`,
      );
      continue;
    }
    if (schemas.has(target as InputTarget)) {
      refusals.push(`two \`${target}\` validators, whose schemas this generator will not merge`);
      continue;
    }
    const schema = jsonSchemaOf(input);
    if (typeof schema === 'string') refusals.push(`a \`${target}\` validator with ${schema}`);
    else schemas.set(target as InputTarget, schema);
  }
  const query = schemas.get('query');
  const parameters = [
    ...pathParameters(shape, schemas.get('param'), refusals),
    ...(query === undefined ? [] : queryParameters(query, refusals)),
  ];
  const json = schemas.get('json');
  const operation: Operation = {
    'x-forge-validated': INPUT_TARGETS.filter((t) => schemas.has(t)),
    responses: { default: { description: UNDECLARED_RESPONSE } },
  };
  if (parameters.length > 0) operation.parameters = parameters;
  if (query !== undefined && query.additionalProperties === false) {
    operation['x-forge-query-closed'] = true;
  }
  if (json !== undefined) {
    operation.requestBody = { required: true, content: { 'application/json': { schema: json } } };
  }
  return { operation, refusals };
}

type Endpoint = { method: string; path: string; inputs: DeclaredInput[] };

function endpointsOf(routes: MountedRoute[], refusals: string[]): Endpoint[] {
  const byKey = new Map<string, Endpoint>();
  const middleware: MountedRoute[] = [];
  for (const route of routes) {
    if (route.method === 'ALL') {
      middleware.push(route);
      continue;
    }
    const key = `${route.method} ${route.path}`;
    const endpoint = byKey.get(key) ?? { method: route.method, path: route.path, inputs: [] };
    byKey.set(key, endpoint);
    const input = inputOf(route.handler);
    if (input !== undefined) endpoint.inputs.push(input);
  }
  const endpoints = [...byKey.values()];
  for (const mw of middleware) {
    const covered = endpoints.filter((e) => middlewareCovers(mw.path, e.path));
    if (covered.length === 0) {
      refusals.push(
        `ALL ${mw.path}: registered for every method and covering no route — an \`all()\` handler this generator cannot describe, or middleware guarding nothing`,
      );
      continue;
    }
    const input = inputOf(mw.handler);
    if (input !== undefined) for (const e of covered) e.inputs.push(input);
  }
  return endpoints;
}

function byMethodOrder(a: string, b: string): number {
  return METHOD_ORDER.indexOf(a) - METHOD_ORDER.indexOf(b);
}

export function buildApiContract(routes: MountedRoute[], info: JsonSchema): ApiContract {
  const refusals: string[] = [];
  const paths: Record<string, Record<string, Operation>> = {};
  let operations = 0;
  const endpoints = endpointsOf(routes, refusals).sort((a, b) =>
    a.path < b.path ? -1 : a.path > b.path ? 1 : byMethodOrder(a.method, b.method),
  );
  for (const endpoint of endpoints) {
    const name = `${endpoint.method} ${endpoint.path}`;
    if (!METHOD_ORDER.includes(endpoint.method)) {
      refusals.push(`${name}: the method \`${endpoint.method}\`, which OpenAPI has no field for`);
      continue;
    }
    const shape = pathShape(endpoint.path);
    if (typeof shape === 'string') {
      refusals.push(`${name}: ${shape}`);
      continue;
    }
    const described = describe(shape, endpoint.inputs);
    for (const why of described.refusals) refusals.push(`${name}: ${why}`);
    const item = paths[shape.template] ?? {};
    const method = endpoint.method.toLowerCase();
    if (item[method] !== undefined) {
      refusals.push(
        `${name}: a second route reaching \`${method.toUpperCase()} ${shape.template}\``,
      );
      continue;
    }
    item[method] = described.operation;
    paths[shape.template] = item;
    operations += 1;
  }
  return { document: { openapi: '3.1.0', info, paths }, operations, refusals };
}
