import { zValidator as honoZValidator } from '@hono/zod-validator';
import type { Context, MiddlewareHandler } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { matchedRoutes } from 'hono/route';
import { findTargetHandler } from 'hono/utils/handler';
import { type ZodType, z } from 'zod';
import { isBareRefusal } from '../../lib/refusal-sentence.js';
import {
  fieldsNamedAt,
  fieldsPolicy,
  refusesItself,
  unknownFields,
} from '../../lib/unknown-fields.js';
import { schemaRefusalWords, schemaRefused } from '../../lib/zod-sentences.js';

/** What a route's input validator was built from, which the mounted middleware no longer shows. */
export type ValidatorDeclaration = {
  readonly target: 'param' | 'query' | 'json' | 'form' | 'header' | 'cookie';
  readonly schema: ZodType;
  readonly hook: ((...args: never[]) => unknown) | null;
  readonly enforced?: boolean;
};

export const validatorDeclarations = new WeakMap<object, ValidatorDeclaration>();

type Parsed = { success: boolean; error?: z.core.$ZodError; data?: unknown };
type Hook = (result: Parsed, c: Context) => unknown;

/** The parse's own issues as sentences, and its details with the values each fixed-set field takes. */
function inWords(
  error: z.core.$ZodError,
  details: unknown,
  schema: ZodType,
  input: unknown,
): { message: string; details: unknown } {
  const { sentences, accepted } = schemaRefusalWords(error.issues, {
    valuesAre: 'listed in details.accepted',
    input,
    fieldsAt: (path) => fieldsNamedAt(schema, path),
  });
  if (accepted.length === 0) return { message: sentences.join(' '), details };
  const values = { accepted: Object.fromEntries(accepted.map((a) => [a.field, a.values])) };
  const held = details !== null && typeof details === 'object' && !Array.isArray(details);
  return {
    message: sentences.join(' '),
    details: held ? { ...details, ...values } : details == null ? values : details,
  };
}

/** A route hook's thrown refusal, re-worded from the parse's own issues where it was not a sentence. */
function worded(
  thrown: unknown,
  result: Parsed & { error: z.core.$ZodError },
  schema: ZodType,
): unknown {
  if (!(thrown instanceof HTTPException) || thrown.status >= 500) return thrown;
  if (!isBareRefusal(thrown.message)) return thrown;
  const cause = (thrown.cause ?? {}) as { code?: unknown; details?: unknown };
  const { message, details } = inWords(result.error, cause.details, schema, result.data);
  return new HTTPException(thrown.status, { message, cause: { ...cause, details } });
}

/** A refusal a hook answered itself, re-worded the same way; any other answer passes untouched. */
async function wordedAnswer(
  answered: Response,
  result: Parsed & { error: z.core.$ZodError },
  schema: ZodType,
): Promise<Response> {
  if (answered.status < 400 || answered.status >= 500) return answered;
  if (!answered.headers.get('content-type')?.includes('application/json')) return answered;
  const body = (await answered
    .clone()
    .json()
    .catch(() => null)) as Record<string, unknown> | null;
  if (!body || typeof body.message !== 'string' || !isBareRefusal(body.message)) return answered;
  const { message, details } = inWords(result.error, body.details, schema, result.data);
  return new Response(JSON.stringify({ ...body, message, details }), {
    status: answered.status,
    headers: answered.headers,
  });
}

/**
 * ISS-1421 r14: a failed parse is refused in sentences whatever the route's hook said. A hook's
 * refusal keeps its status and code and loses only a message that was not a sentence; with no hook,
 * or one that let the failure through, the answer is `schemaRefused`, not the library's raw parse.
 */
function sentenced(hook: Hook | undefined, schema: ZodType): Hook {
  return async (result, c) => {
    if (result.success || !result.error) return hook?.(result, c);
    const failed = { ...result, error: result.error };
    let answered: unknown;
    try {
      answered = await hook?.(result, c);
    } catch (thrown) {
      throw worded(thrown, failed, schema);
    }
    if (answered instanceof Response) return wordedAnswer(answered, failed, schema);
    if (answered && typeof answered === 'object' && 'response' in answered) return answered;
    throw schemaRefused(result.error, schema, result.data);
  };
}

/**
 * A JSON body's schema that refuses, by name, a top-level field it does not take (ISS-1421 r15).
 * One that declares it takes any (`.loose()`, `.catchall()`) is that schema's own say and is kept.
 */
export function refusingUnknownFields(schema: ZodType): ZodType {
  if (fieldsPolicy(schema) === 'open') return schema;
  return z
    .unknown()
    .superRefine((body, ctx) => {
      const keys = unknownFields(schema, body);
      if (keys.length > 0 && !refusesItself(schema, body)) {
        ctx.addIssue({ code: 'unrecognized_keys', keys, input: body as never });
      }
    })
    .pipe(schema as z.ZodType<unknown>);
}

/** `@hono/zod-validator`'s `zValidator`, its failed parse refused in sentences, that also records what it was built from. */
export const zValidator: typeof honoZValidator = ((
  target: ValidatorDeclaration['target'],
  schema: ZodType,
  hook?: ValidatorDeclaration['hook'],
  options?: unknown,
) => {
  const refusing = sentenced((hook ?? undefined) as Hook | undefined, schema);
  const middleware = (honoZValidator as (...args: unknown[]) => MiddlewareHandler)(
    target,
    target === 'json' ? refusingUnknownFields(schema) : schema,
    refusing,
    options,
  );
  validatorDeclarations.set(middleware, { target, schema, hook: refusing as never });
  return middleware;
}) as typeof honoZValidator;

/** A body refused for the fields named, in the sentence the shared validator says it in. */
export function unknownFieldsRefused(keys: string[], schema?: ZodType): HTTPException {
  const { sentences } = schemaRefusalWords([{ code: 'unrecognized_keys', keys, path: [] }], {
    valuesAre: 'listed in details.accepted',
    ...(schema ? { fieldsAt: (path: readonly PropertyKey[]) => fieldsNamedAt(schema, path) } : {}),
  });
  return new HTTPException(400, {
    message: sentences.join(' '),
    cause: { code: 'BAD_REQUEST', details: { unknownFields: keys } },
  });
}

/**
 * Declares the schema a handler parses an input with itself. The handler keeps its own refusals;
 * a JSON body field the schema does not name is refused here first, as the shared validator does.
 */
export function declaresInput(
  target: ValidatorDeclaration['target'],
  schema: ZodType,
): MiddlewareHandler {
  const middleware: MiddlewareHandler = async (c, next) => {
    if (target === 'json' && fieldsPolicy(schema) !== 'open') {
      // Hono keeps the parsed body, so the handler's own read gets the same one.
      const body = await c.req.json().catch(() => undefined);
      const keys = unknownFields(schema, body);
      if (keys.length > 0) throw unknownFieldsRefused(keys, schema);
    }
    return next();
  };
  validatorDeclarations.set(middleware, { target, schema, hook: null, enforced: false });
  return middleware;
}

/** Why a route takes its request body as it was sent, keyed by the middleware that says so. */
export const bodyTakenAsSent = new WeakMap<object, string>();

/**
 * Declares a route that reads its own body (raw bytes, a multipart form, JSON-RPC) or keeps a field
 * it does not read, with the reason a caller reads in the API reference; every other route has its
 * body checked against the schema it declares, or refused where it declares none (ISS-1421 r16).
 */
export function takesBodyAsSent(reason: string): MiddlewareHandler {
  const middleware: MiddlewareHandler = async (_c, next) => next();
  bodyTakenAsSent.set(middleware, reason);
  return middleware;
}

const WRITES = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/** What the API reference states for a write route that declares no body (ISS-1421 r16). */
export const BODY_NOT_TAKEN_WHEN = 'the request carries a body, and this call takes none';

/** The handlers of the route that answers this request, its gates mounted for every path aside. */
function ownHandlers(c: Context): object[] | null {
  const matched = matchedRoutes(c);
  const route = matched.find((r) => r.method !== 'ALL');
  if (!route) return null;
  return matched
    .filter((r) => r.method === route.method && r.path === route.path)
    .map((r) => findTargetHandler(r.handler as never) as object);
}

function takesABody(handlers: readonly object[]): boolean {
  return handlers.some((h) => {
    const target = validatorDeclarations.get(h)?.target;
    return target === 'json' || target === 'form' || bodyTakenAsSent.has(h);
  });
}

/** The most of a body this reads: past it, the body is refused unread, before any gate runs. */
export const MOST_READ_BYTES = 64 * 1024;

/** The body as text, or null past `MOST_READ_BYTES`, read no further than that. */
async function boundedText(body: ReadableStream<Uint8Array>): Promise<string | null> {
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MOST_READ_BYTES) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/** The fields a body names, `[]` for one that is not a JSON object, null for none at all. */
async function sentFields(c: Context): Promise<string[] | null> {
  const body = c.req.raw.body;
  if (c.req.header('content-length') === '0' || !body) return null;
  if (Number(c.req.header('content-length')) > MOST_READ_BYTES) return [];
  const read = await boundedText(body);
  if (read === null) return [];
  const text = read.trim();
  if (text === '') return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return [];
  }
  if (parsed === null) return null;
  if (typeof parsed !== 'object' || Array.isArray(parsed)) return [];
  const keys = Object.keys(parsed);
  return keys.length > 0 ? keys : null;
}

/**
 * A write route that declares no body refuses one, naming each field, before any gate or handler
 * runs: a pairing code asked for one minute was minted for ten while the field was dropped
 * unread. An empty body, `{}` and `null` are no body. A route that reads its own body says why with
 * `takesBodyAsSent`.
 */
export function refuseBodyNotTaken(): MiddlewareHandler {
  return async (c, next) => {
    if (!WRITES.has(c.req.method)) return next();
    const handlers = ownHandlers(c);
    if (!handlers || takesABody(handlers)) return next();
    const fields = await sentFields(c);
    if (fields === null) return next();
    if (fields.length > 0) throw unknownFieldsRefused(fields);
    throw new HTTPException(400, {
      message: 'This call takes no body.',
      cause: { code: 'BAD_REQUEST', details: { takesNoBody: true } },
    });
  };
}
