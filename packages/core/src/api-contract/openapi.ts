import { COMPOSED_HANDLER } from 'hono/utils/constants';
import { z } from 'zod';
import { AUTH_GATES, type AuthGate, declaredGates } from '../middleware/declared-gate.js';
import {
  type DeclaredInput,
  type DeclaredRawBody,
  declaredInputs,
  declaredRawBodies,
} from '../middleware/zod-validator.js';
import { type RequestRead, readsOf } from './request-reads.js';

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

type Declaration =
  | { kind: 'input'; input: DeclaredInput }
  | { kind: 'raw'; body: DeclaredRawBody }
  | { kind: 'gate'; gate: AuthGate }
  | { kind: 'handler'; reads: RequestRead[] };

function declarationOf(handler: unknown): Declaration {
  const inner = unwrap(handler);
  if (typeof inner !== 'function') return { kind: 'handler', reads: [] };
  const input = declaredInputs.get(inner);
  if (input !== undefined) return { kind: 'input', input };
  const body = declaredRawBodies.get(inner);
  if (body !== undefined) return { kind: 'raw', body };
  const gate = declaredGates.get(inner);
  if (gate !== undefined) return { kind: 'gate', gate };
  return { kind: 'handler', reads: readsOf(Function.prototype.toString.call(inner)) };
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

export const UNNAMED_REFINEMENT =
  'a refinement with no fixed message, whose rule this contract cannot state';

type CheckDef = { check?: string; error?: unknown };

// cm:why JSON Schema has no word for a predicate, so a refine() is named by the message it
// refuses with: what a caller can see of the rule, without inventing the rule itself
function refinementsOf(checks: unknown[] | undefined): string[] {
  const out: string[] = [];
  for (const check of checks ?? []) {
    const def = (check as { _zod?: { def?: CheckDef } })._zod?.def;
    if (def?.check !== 'custom') continue;
    let message: unknown;
    try {
      message = typeof def.error === 'function' ? def.error({ code: 'custom' }) : undefined;
    } catch {
      message = undefined;
    }
    const text =
      typeof message === 'string'
        ? message
        : typeof (message as { message?: unknown } | undefined)?.message === 'string'
          ? (message as { message: string }).message
          : UNNAMED_REFINEMENT;
    if (!out.includes(text)) out.push(text);
  }
  return out;
}

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
      const def = ctx.zodSchema._zod.def as { type: string; coerce?: boolean; checks?: unknown[] };
      const refinements = refinementsOf(def.checks);
      if (refinements.length > 0) ctx.jsonSchema['x-forge-refinements'] = refinements;
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

function readRefusals(endpoint: Endpoint, validated: Set<string>): string[] {
  const refusals: string[] = [];
  const hasBody = validated.has('json') || endpoint.raws.length > 0;
  for (const read of endpoint.reads) {
    if (read.kind === 'validated' && !validated.has(read.part)) {
      refusals.push(`reads \`${read.via}\` and holds no \`${read.part}\` validator`);
    } else if (read.kind === 'body' && !hasBody) {
      refusals.push(
        `reads the request body with \`${read.via}\` and declares no body — hold zValidator('json', …), or rawBody(…) for a body that is not JSON`,
      );
    } else if (read.kind === 'query' && !validated.has('query')) {
      refusals.push(
        `reads the query with \`${read.via}\` and holds no query validator — hold zValidator('query', …) and read c.req.valid('query')`,
      );
    }
  }
  if (endpoint.raws.length > 1) refusals.push('two rawBody() declarations for one body');
  if (endpoint.raws.length > 0 && validated.has('json')) {
    refusals.push('a json validator and a rawBody() declaration for one body');
  }
  return [...new Set(refusals)];
}

function describe(shape: PathShape, endpoint: Endpoint): Described {
  const refusals: string[] = [];
  const schemas = new Map<InputTarget, JsonSchema>();
  const targets = new Set<string>();
  for (const input of endpoint.inputs) {
    const target = input.target as string;
    targets.add(target);
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
  refusals.push(...readRefusals(endpoint, targets));
  const query = schemas.get('query');
  const parameters = [
    ...pathParameters(shape, schemas.get('param'), refusals),
    ...(query === undefined ? [] : queryParameters(query, refusals)),
  ];
  const json = schemas.get('json');
  const raw = endpoint.raws[0];
  const operation: Operation = {
    'x-forge-auth': endpoint.gates,
    'x-forge-validated': INPUT_TARGETS.filter((t) => schemas.has(t)),
    responses: { default: { description: UNDECLARED_RESPONSE } },
  };
  if (parameters.length > 0) operation.parameters = parameters;
  if (query !== undefined && query.additionalProperties === false) {
    operation['x-forge-query-closed'] = true;
  }
  if (json !== undefined) {
    operation.requestBody = { required: true, content: { 'application/json': { schema: json } } };
  } else if (raw !== undefined) {
    operation.requestBody = {
      required: raw.required,
      description: raw.description,
      content: { [raw.contentType]: { schema: {} } },
    };
  }
  if (operation.parameters === undefined && operation.requestBody === undefined) {
    operation['x-forge-input'] = 'none';
  }
  return { operation, refusals };
}

type Endpoint = {
  method: string;
  path: string;
  inputs: DeclaredInput[];
  raws: DeclaredRawBody[];
  gates: AuthGate[];
  reads: RequestRead[];
  last: number;
};

function declare(endpoint: Endpoint, declaration: Declaration): void {
  if (declaration.kind === 'input') endpoint.inputs.push(declaration.input);
  else if (declaration.kind === 'raw') endpoint.raws.push(declaration.body);
  else if (declaration.kind === 'gate') {
    if (!endpoint.gates.includes(declaration.gate)) endpoint.gates.push(declaration.gate);
  } else endpoint.reads.push(...declaration.reads);
}

// cm:why Hono runs a route's handlers in registration order and stops at the one that answers,
// so middleware registered after a route's last handler never guards or validates it
function endpointsOf(routes: MountedRoute[], refusals: string[]): Endpoint[] {
  const byKey = new Map<string, Endpoint>();
  routes.forEach((route, index) => {
    if (route.method === 'ALL') return;
    const key = `${route.method} ${route.path}`;
    const endpoint = byKey.get(key) ?? {
      method: route.method,
      path: route.path,
      inputs: [],
      raws: [],
      gates: [],
      reads: [],
      last: index,
    };
    endpoint.last = index;
    byKey.set(key, endpoint);
  });
  const endpoints = [...byKey.values()];
  routes.forEach((route, index) => {
    const declaration = declarationOf(route.handler);
    if (route.method !== 'ALL') {
      const endpoint = byKey.get(`${route.method} ${route.path}`);
      if (endpoint !== undefined) declare(endpoint, declaration);
      return;
    }
    const covered = endpoints.filter((e) => middlewareCovers(route.path, e.path));
    if (covered.length === 0) {
      refusals.push(
        `ALL ${route.path}: registered for every method and covering no route — an \`all()\` handler this generator cannot describe, or middleware guarding nothing`,
      );
      return;
    }
    for (const e of covered) if (index < e.last) declare(e, declaration);
  });
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
    const described = describe(shape, endpoint);
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
  const document = { openapi: '3.1.0', info, 'x-forge-auth-gates': AUTH_GATES, paths };
  return { document, operations, refusals };
}
