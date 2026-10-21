import { UNKNOWN_QUERY_PARAMETER } from '../../lib/query-strict.js';
import { fieldsPolicy } from '../../lib/unknown-fields.js';
import { PAT_DOOR_REFUSALS } from '../../middleware/pat-rest-surface.js';
import { type Answer, codeFor } from '../declare/describe.js';
import {
  alongside,
  ERROR_ENVELOPE,
  ERROR_ENVELOPE_NAME,
  errorResponse,
} from '../declare/errors.js';
import { type JsonSchema, renderSchema } from '../declare/schema.js';
import { BODY_NOT_TAKEN_WHEN, type ValidatorDeclaration } from '../declare/validator.js';
import { type Access, accessOf, accessProse, asksForBearer } from './access.js';
import { type InputRefusal, probeInputRefusal } from './probe-hook.js';
import { type RouteEntry, type RouteSource, readRoutes } from './registry.js';
import type { Rule } from './rules.js';

export type Finding = {
  readonly rule: Rule;
  /** `GET /api/issues/:id`, or the name of the thing the finding is about when it is not one route. */
  readonly route: string;
  readonly detail: string;
};

export type OpenApiDocument = {
  openapi: '3.1.0';
  info: Record<string, unknown>;
  servers: Array<{ url: string }>;
  tags: Array<{ name: string }>;
  paths: Record<string, Record<string, Record<string, unknown>>>;
  components: {
    securitySchemes: Record<string, unknown>;
    schemas: Record<string, JsonSchema>;
  };
};

/** The error codes each route can answer with, by status: what the route's own response lists. */
export type AnsweredErrors = ReadonlyMap<number, ReadonlySet<string>>;

export type Reference = {
  readonly document: OpenApiDocument;
  readonly routes: readonly RouteEntry[];
  readonly findings: readonly Finding[];
  /** Keyed by `RouteEntry.key`. */
  readonly errors: ReadonlyMap<string, AnsweredErrors>;
};

const BEARER_SCHEME = 'bearerAuth';

const IN_FOR_TARGET: Record<ValidatorDeclaration['target'], string> = {
  param: 'path',
  query: 'query',
  header: 'header',
  cookie: 'cookie',
  json: 'body',
  form: 'body',
};

/** `/api/issues/:id{[0-9]+}/x?` as OpenAPI writes it: `/api/issues/{id}/x`. */
export function openApiPath(path: string): string {
  return path
    .split('/')
    .map((segment) => {
      const named = /^:([A-Za-z0-9_]+)(\{.*\})?\??$/.exec(segment);
      return named ? `{${named[1]}}` : segment;
    })
    .join('/');
}

function pathParams(path: string): string[] {
  return [...path.matchAll(/\/:([A-Za-z0-9_]+)(?:\{[^}]*\})?\??(?=\/|$)/g)].map((m) => m[1] ?? '');
}

function pascal(word: string): string {
  return word.charAt(0).toUpperCase() + word.slice(1);
}

function operationIdOf(method: string, path: string): string {
  const parts = path
    .split('/')
    .filter(Boolean)
    .map((segment) => {
      const named = /^:([A-Za-z0-9_]+)/.exec(segment);
      if (named) return `By${pascal(named[1] ?? '')}`;
      return segment
        .split(/[^A-Za-z0-9]+/)
        .filter(Boolean)
        .map(pascal)
        .join('');
    });
  return `${method.toLowerCase()}${parts.join('') || 'Root'}`;
}

function tagOf(path: string): string {
  const segments = path.split('/').filter(Boolean);
  const first = segments[0] === 'api' ? segments[1] : segments[0];
  return first && !first.startsWith(':') ? first : 'root';
}

type ObjectProperties = {
  readonly properties: Record<string, JsonSchema>;
  readonly required: ReadonlySet<string>;
};

/** The named fields of an object schema, through `allOf` and a union's members. */
function propertiesOf(schema: JsonSchema): ObjectProperties | null {
  const properties: Record<string, JsonSchema> = {};
  const required = new Set<string>();
  let found = false;
  const take = (node: JsonSchema, mandatory: boolean) => {
    const own = node.properties as Record<string, JsonSchema> | undefined;
    if (own) {
      found = true;
      Object.assign(properties, own);
      if (mandatory)
        for (const name of (node.required as string[] | undefined) ?? []) required.add(name);
    }
    for (const member of (node.allOf as JsonSchema[] | undefined) ?? []) take(member, mandatory);
    for (const key of ['anyOf', 'oneOf'] as const) {
      for (const member of (node[key] as JsonSchema[] | undefined) ?? []) take(member, false);
    }
  };
  take(schema, true);
  return found || schema.type === 'object' ? { properties, required } : null;
}

class Document {
  readonly schemas: Record<string, JsonSchema> = { [ERROR_ENVELOPE_NAME]: ERROR_ENVELOPE };
  readonly findings: Finding[] = [];

  lift(route: string, defs: Record<string, JsonSchema>): void {
    for (const [name, def] of Object.entries(defs)) {
      const held = this.schemas[name];
      if (held && JSON.stringify(held) !== JSON.stringify(def)) {
        this.findings.push({
          rule: 'schema-name-clash',
          route,
          detail: `two different schemas are both named "${name}"; a name carries one shape`,
        });
        continue;
      }
      this.schemas[name] = def;
    }
  }

  render(
    route: string,
    what: string,
    schema: Parameters<typeof renderSchema>[0],
    io: 'input' | 'output',
  ) {
    const rendered = renderSchema(schema, io);
    for (const where of rendered.unrepresentable) {
      this.findings.push({
        rule: 'unrepresentable',
        route,
        detail: `${what} has a type JSON Schema cannot hold at ${where}`,
      });
    }
    this.lift(route, rendered.defs);
    return rendered.schema;
  }
}

function inputsOf(entry: RouteEntry, doc: Document) {
  const parameters: Array<Record<string, unknown>> = [];
  const declaredPath = new Set<string>();
  const bodies: JsonSchema[] = [];
  for (const declaration of entry.validators) {
    const schema = doc.render(
      entry.key,
      `the ${declaration.target} schema`,
      declaration.schema,
      'input',
    );
    if (declaration.target === 'json') {
      bodies.push(schema);
      continue;
    }
    if (declaration.target === 'form') continue;
    const fields = propertiesOf(schema);
    if (!fields) {
      doc.findings.push({
        rule: 'unrepresentable',
        route: entry.key,
        detail: `the ${declaration.target} schema is not an object schema, so it names no parameters`,
      });
      continue;
    }
    for (const [name, field] of Object.entries(fields.properties)) {
      const where = IN_FOR_TARGET[declaration.target];
      if (declaration.target === 'param') declaredPath.add(name);
      const { description, ...rest } = field as { description?: string } & JsonSchema;
      parameters.push({
        name,
        in: where,
        required: declaration.target === 'param' || fields.required.has(name),
        schema: rest,
        ...(description ? { description } : {}),
      });
    }
  }
  const inPath = pathParams(entry.path);
  for (const name of inPath) {
    if (declaredPath.has(name)) continue;
    doc.findings.push({
      rule: 'undeclared-input',
      route: entry.key,
      detail: `path parameter :${name} has no schema: validate it with zValidator('param', ...) or declare it`,
    });
    parameters.push({ name, in: 'path', required: true, schema: { type: 'string' } });
  }
  for (const name of declaredPath) {
    if (inPath.includes(name)) continue;
    doc.findings.push({
      rule: 'param-not-in-path',
      route: entry.key,
      detail: `the param schema names "${name}", which is not a segment of ${entry.path}`,
    });
  }
  return { parameters, bodies };
}

const WRITE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/** A write route `refuseBodyNotTaken` holds to no body: it declares none and names no reason. */
function takesNoBody(entry: RouteEntry): boolean {
  if (!WRITE_METHODS.has(entry.method) || entry.bodyAsSent !== null) return false;
  return !entry.validators.some((v) => v.target === 'json' || v.target === 'form');
}

type ErrorCodes = Map<number, Map<string, string[]>>;

function addCode(into: ErrorCodes, status: number, code: string, when: string): void {
  const byCode = into.get(status) ?? new Map<string, string[]>();
  const whens = byCode.get(code) ?? [];
  if (when !== '' && !whens.includes(when)) whens.push(when);
  byCode.set(code, whens);
  into.set(status, byCode);
}

async function refusalOf(entry: RouteEntry, declaration: ValidatorDeclaration, doc: Document) {
  const refusal: InputRefusal = await probeInputRefusal(declaration);
  if (refusal.kind === 'unreadable') {
    doc.findings.push({
      rule: 'unreadable-hook',
      route: entry.key,
      detail: `the ${declaration.target} validator's hook could not be run to read what it refuses with: ${refusal.why}`,
    });
  }
  return refusal;
}

/** What the reference states for a query key a route does not take. */
const STRAY_QUERY_KEY_WHEN =
  'a query parameter this route does not take; details lists the ones it does';

async function responsesOf(entry: RouteEntry, access: Access | null, doc: Document) {
  const responses: Record<string, JsonSchema> = {};
  const errors: ErrorCodes = new Map();
  const declared = entry.operations[0];
  let succeeded = false;
  const answer = (status: number, a: Answer) => {
    if (a.kind === 'fail') {
      for (const { code, when } of a.codes) addCode(errors, status, codeFor(status, code), when);
      return;
    }
    if (status < 400) succeeded = true;
    if (a.kind === 'json') {
      const schema = doc.render(entry.key, `the ${status} response`, a.schema, 'output');
      responses[String(status)] = {
        description: a.description,
        content: {
          'application/json': { schema },
          ...(a.alsoAs === undefined ? {} : { [a.alsoAs]: { schema: { type: 'string' } } }),
        },
      };
    } else if (a.kind === 'raw') {
      if (/json/i.test(a.contentType)) {
        doc.findings.push({
          rule: 'raw-json',
          route: entry.key,
          detail: `the ${status} response is declared raw(${a.contentType}), which states a JSON body as a string: declare it with json(schema)`,
        });
      }
      responses[String(status)] = {
        description: a.description,
        content: { [a.contentType]: { schema: { type: 'string' } } },
      };
    } else if (a.kind === 'redirect') {
      responses[String(status)] = {
        description: a.description,
        headers: { Location: { schema: { type: 'string' } } },
      };
    } else {
      responses[String(status)] = { description: a.description };
    }
  };
  for (const [status, a] of Object.entries(declared?.responses ?? {})) answer(Number(status), a);
  for (const refusal of entry.refusals) addCode(errors, refusal.status, refusal.code, refusal.when);
  if (takesNoBody(entry)) addCode(errors, 400, 'BAD_REQUEST', BODY_NOT_TAKEN_WHEN);
  // A route that reads no bearer never meets the token door. One kept out of the grant still meets
  // it when a token is sent to it, and the door turns the token away there by name.
  const doorRefusals = !asksForBearer(access, entry.takesBearer)
    ? []
    : access?.door === 'token'
      ? PAT_DOOR_REFUSALS
      : PAT_DOOR_REFUSALS.filter(
          (r) => r.code === 'INVALID_TOKEN' || r.code === 'PAT_NOT_PERMITTED',
        );
  for (const refusal of doorRefusals) addCode(errors, refusal.status, refusal.code, refusal.when);
  addCode(
    errors,
    500,
    'INTERNAL_ERROR',
    'an unexpected failure; nothing about the request is to blame',
  );
  for (const declaration of entry.validators) {
    // Every query refuses a key it does not take, whoever parses it (ISS-1421 r19).
    if (declaration.target === 'query' && fieldsPolicy(declaration.schema) !== 'open')
      addCode(errors, 400, UNKNOWN_QUERY_PARAMETER, STRAY_QUERY_KEY_WHEN);
    if (declaration.enforced === false) continue;
    const refusal = await refusalOf(entry, declaration, doc);
    if (refusal.kind === 'refused')
      addCode(errors, refusal.status, refusal.code, `the ${declaration.target} failed its schema`);
  }
  for (const [status, byCode] of errors) {
    const codes = [...byCode].map(([code, whens]) => ({ code, when: whens.join('; ') }));
    const envelope = errorResponse(codes);
    const declaredJson = responses[String(status)];
    responses[String(status)] = declaredJson ? alongside(declaredJson, envelope) : envelope;
  }
  if (!succeeded && !declared?.retired) {
    doc.findings.push({
      rule: 'no-response',
      route: entry.key,
      detail:
        'no success response is declared: attach describeOperation({ responses: { 200: json(schema) } })',
    });
  }
  const answered = new Map<number, ReadonlySet<string>>(
    [...errors].map(([status, byCode]) => [status, new Set(byCode.keys())]),
  );
  return { responses, answered };
}

function accessExtension(access: Access, readsBearer: boolean): Record<string, unknown> {
  if (access.door === 'token' && !readsBearer) {
    return {
      door: 'none',
      reason: 'its gates read no bearer, so no token grant applies and no permission is checked',
    };
  }
  if (access.door === 'token') {
    return { door: 'token', permission: access.permission, reach: access.reach };
  }
  return {
    door: access.door,
    reason: access.reason,
    instead: access.instead,
    excludedBy: access.pattern,
  };
}

export const REFERENCE_DESCRIPTION = [
  'Every route Forge core serves, read from the route table of the running app.',
  '',
  "An operation's inputs are the schemas its handler validates with, its errors are the codes its gates and handler throw, and `x-forge-access` is the grant a personal or agent token needs, read from `auth/pat-permissions.ts`. A refusal for a bad input is read by running the route's own validation hook.",
  '',
  "What this document does not prove on its own: that a handler's response body has the shape its schema declares. The pull request gate proves the document is complete and consistent with the routes. The integration run validates each JSON response against the schema declared for it, and runs after a merge, so that agreement is checked for the routes the integration suite exercises.",
].join('\n');

/**
 * The reference for this app: one operation for every route it serves, each stating its inputs,
 * its answers and its access, and every way the document falls short of the routes, named.
 *
 * It never omits a route to stay tidy and never renders a type it cannot represent as one that
 * accepts anything. What it cannot state it reports as a finding, and the check turns each finding
 * into a failure that names the route.
 */
export async function buildReference(
  app: RouteSource,
  info: { version: string },
): Promise<Reference> {
  const routes = readRoutes(app);
  const doc = new Document();
  const paths: OpenApiDocument['paths'] = {};
  const tags = new Set<string>();
  const ids = new Map<string, string>();
  const errors = new Map<string, AnsweredErrors>();

  for (const entry of routes) {
    if (entry.unread)
      doc.findings.push({ rule: 'unread-chain', route: entry.key, detail: entry.unread });
    if (entry.operations.length > 1) {
      doc.findings.push({
        rule: 'more-than-one-descriptor',
        route: entry.key,
        detail: `${entry.operations.length} describeOperation descriptors are mounted on one route`,
      });
    }
    const access = accessOf(entry.method, entry.path);
    if (!access) {
      doc.findings.push({
        rule: 'no-access',
        route: entry.key,
        detail:
          'the path is in neither PAT_PERMISSION_RESOURCES nor PAT_UNGRANTABLE (auth/pat-permissions.ts)',
      });
    }
    const { parameters, bodies } = inputsOf(entry, doc);
    const declared = entry.operations[0];
    const requestBody = (() => {
      if (bodies.length > 0) {
        const schema = bodies.length === 1 ? (bodies[0] as JsonSchema) : { allOf: bodies };
        return { required: true, content: { 'application/json': { schema } } };
      }
      if (declared?.body) {
        return {
          required: true,
          description: declared.body.description,
          content: {
            [declared.body.contentType]: {
              schema:
                declared.body.filePart === undefined
                  ? { type: 'string', format: 'binary' }
                  : {
                      type: 'object',
                      required: [declared.body.filePart],
                      properties: {
                        [declared.body.filePart]: { type: 'string', format: 'binary' },
                      },
                    },
            },
          },
        };
      }
      return undefined;
    })();
    const answers = await responsesOf(entry, access, doc);
    errors.set(entry.key, answers.answered);
    const tag = tagOf(entry.path);
    tags.add(tag);
    const openApi = openApiPath(entry.path);
    const method = entry.method.toLowerCase();
    const operationId = operationIdOf(entry.method, entry.path);
    const held = ids.get(operationId);
    if (held && held !== entry.key) {
      doc.findings.push({
        rule: 'operation-id-clash',
        route: entry.key,
        detail: `operationId ${operationId} is also ${held}`,
      });
    }
    ids.set(operationId, entry.key);
    const described = [
      accessProse(access, entry.takesBearer),
      declared?.description,
      entry.bodyAsSent ? `Takes its body as sent: ${entry.bodyAsSent}.` : null,
    ]
      .filter(Boolean)
      .join('\n\n');
    const operation: Record<string, unknown> = {
      operationId,
      tags: [tag],
      ...(declared?.summary ? { summary: declared.summary } : {}),
      ...(described ? { description: described } : {}),
      ...(declared?.retired ? { deprecated: true } : {}),
      ...(parameters.length > 0 ? { parameters } : {}),
      ...(requestBody ? { requestBody } : {}),
      responses: answers.responses,
      security: asksForBearer(access, entry.takesBearer) ? [{ [BEARER_SCHEME]: [] }] : [],
      ...(access
        ? { 'x-forge-access': accessExtension(access, asksForBearer(access, entry.takesBearer)) }
        : {}),
    };
    paths[openApi] = { ...(paths[openApi] ?? {}), [method]: operation };
  }

  return {
    document: {
      openapi: '3.1.0',
      info: {
        title: 'Forge core API',
        version: info.version,
        description: REFERENCE_DESCRIPTION,
      },
      servers: [{ url: '/' }],
      tags: [...tags].sort().map((name) => ({ name })),
      paths,
      components: {
        securitySchemes: {
          [BEARER_SCHEME]: {
            type: 'http',
            scheme: 'bearer',
            description:
              "The credential the route's `x-forge-access.door` names: a personal or agent token (`forge_pat_…`) for a token route, a session JWT, or a paired box's device credential.",
          },
        },
        schemas: doc.schemas,
      },
    },
    routes,
    findings: doc.findings,
    errors,
  };
}
