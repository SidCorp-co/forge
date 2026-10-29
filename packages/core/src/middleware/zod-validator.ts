import { zValidator as honoZodValidator } from '@hono/zod-validator';
import type { Context, MiddlewareHandler, Next } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import { jsonPointer, type Refusal, RefusalError } from '../lib/refusal.js';

type Args = Parameters<typeof honoZodValidator>;

export type DeclaredInput = { target: Args[0]; schema: Args[1] };

export type DeclaredRawBody = { contentType: string; description: string; required: boolean };

const declared = new WeakMap<object, DeclaredInput>();
const declaredRaw = new WeakMap<object, DeclaredRawBody>();

export const declaredInputs: Pick<WeakMap<object, DeclaredInput>, 'get'> = declared;
export const declaredRawBodies: Pick<WeakMap<object, DeclaredRawBody>, 'get'> = declaredRaw;

type Hook = NonNullable<Args[2]>;
type Failed = { success: boolean; error?: z.core.$ZodError };
type Shape = { hint?: string | undefined; code: string };

const shapes = new WeakMap<object, Shape>();

// a query key a route refuses because another route reads it: the refusal names that route
const elsewhere = new WeakMap<object, Readonly<Record<string, string>>>();

function unknownQueryKeys(
  schema: unknown,
  error: z.core.$ZodError,
  readAt: Readonly<Record<string, string>> = {},
): HTTPException | null {
  const unknown = [
    ...new Set(error.issues.flatMap((i) => (i.code === 'unrecognized_keys' ? i.keys : []))),
  ];
  if (unknown.length === 0) return null;
  const shape = (schema as { shape?: Record<string, unknown> }).shape;
  const keys = shape ? Object.keys(shape).sort() : null;
  const takes =
    keys === null
      ? ''
      : keys.length === 0
        ? ' This route takes no query parameters.'
        : ` This route takes: ${keys.join(', ')}.`;
  const rows: Refusal[] = [
    ...unknown.map((key) => ({
      code: 'UNKNOWN_QUERY_PARAMETER',
      path: jsonPointer([key]),
      detail: `\`${key}\` is not a query parameter of this route.${takes}${pointerTo(readAt, key)}`,
    })),
    ...error.issues
      .filter((i) => i.code !== 'unrecognized_keys')
      .map((i) => ({ code: 'BAD_REQUEST', path: jsonPointer(i.path), detail: i.message })),
  ];
  const named = unknown.map((key) => `\`${key}\``).join(', ');
  const pointers = unknown.map((key) => pointerTo(readAt, key)).join('');
  return new HTTPException(400, {
    message: `Unknown query parameter${unknown.length > 1 ? 's' : ''}: ${named}.${takes}${pointers}`,
    cause: { code: 'UNKNOWN_QUERY_PARAMETER', details: rows },
  });
}

const pointerTo = (readAt: Readonly<Record<string, string>>, key: string) =>
  Object.hasOwn(readAt, key) ? ` ${readAt[key]}` : '';

/**
 * The hook of a query that refuses a key another route reads: the refusal of each key `readAt`
 * names says, in its sentence, where that key is read instead. Every other key is refused as any
 * unknown key is.
 */
export function readElsewhere(readAt: Readonly<Record<string, string>>): Hook {
  const hook = (() => undefined) as Hook;
  elsewhere.set(hook, readAt);
  return hook;
}

// a query key no route reads is refused by name rather than dropped, so a misspelt filter never
// answers as if it were absent; a route a third party redirects to (OAuth, GitHub) declares a
// z.looseObject, and its catchall is left as declared
function strictQuery<S>(schema: S): S {
  const object = schema as unknown as z.ZodObject;
  const def = object._zod?.def as { type?: string; catchall?: unknown } | undefined;
  return def?.type === 'object' && def.catchall === undefined
    ? (object.strict() as unknown as S)
    : schema;
}

function inputRefusal(error: unknown, { hint, code }: Shape): HTTPException {
  return new HTTPException(400, {
    message: hint ?? 'Invalid input',
    cause: { code, details: error },
  });
}

/**
 * The one answer to an input its schema refuses: 400, a refusal row per failing field, and `hint`
 * (the valid shape, in words) as the envelope's detail where the route gives one. A query naming a
 * key its schema does not take is refused by that key, with the keys the route takes.
 * `code` stays BAD_REQUEST unless the route answers this shape under a code of its own.
 */
export function invalid(hint?: string, code = 'BAD_REQUEST'): Hook {
  const shape = { hint, code };
  const hook = ((r: Failed) => {
    if (!r.success) throw inputRefusal(r.error, shape);
  }) as Hook;
  shapes.set(hook, shape);
  return hook;
}

function sentAs(value: unknown): string {
  if (value === undefined) return 'left out';
  const json = JSON.stringify(value) ?? String(value);
  const shown = json.length > 120 ? `${json.slice(0, 117)}...` : json;
  if (typeof value === 'string') return `the bare string ${shown}`;
  if (Array.isArray(value)) return `the array ${shown}`;
  return `${value === null ? '' : `the ${typeof value} `}${shown}`;
}

/**
 * A body whose one field answers its wrong shape under a code of its own: the row names the field,
 * what was sent there and `shape`, the one shape it takes. Every other failing field keeps its
 * BAD_REQUEST row, so one 400 still names every fault.
 */
export function fieldShape(field: string, code: string, shape: string): Hook {
  return ((r: Failed & { data?: unknown }) => {
    if (r.success || !r.error) return;
    refuseFieldShape(r.error.issues, r.data, field, code, shape);
  }) as Hook;
}

/** `fieldShape`'s answer to issues a route's own hook has already read: it throws where one of them
 *  is at `field`, and returns where none is. */
export function refuseFieldShape(
  issues: readonly z.core.$ZodIssue[],
  data: unknown,
  field: string,
  code: string,
  shape: string,
): void {
  if (!issues.some((i) => i.path[0] === field)) return;
  const sent = typeof data === 'object' && data !== null ? Reflect.get(data, field) : null;
  const rows: Refusal[] = [
    { code, path: jsonPointer([field]), detail: `\`${field}\` is ${sentAs(sent)}. ${shape}` },
    ...issues
      .filter((i) => i.path[0] !== field)
      .map((i) => ({ code: 'BAD_REQUEST', path: jsonPointer(i.path), detail: i.message })),
  ];
  throw new RefusalError(rows, 'BAD_REQUEST');
}

/**
 * A body whose one structured field answers its wrong shape under a code of its own, one row per
 * fault at the fault's own path inside it, each naming `shape`. Every other failing field keeps its
 * BAD_REQUEST row. The answer's own detail says every fault at its path, then `shape` once, so a
 * reader of the sentence alone is never shown the first fault only.
 */
export function nestedFieldShape(field: string, code: string, shape: string): Hook {
  return ((r: Failed) => {
    if (r.success || !r.error) return;
    refuseNestedField(r.error.issues, field, code, shape);
  }) as Hook;
}

/** `nestedFieldShape`'s answer to issues a route's own hook has already read: it throws where one
 *  of them is at `field`, and returns where none is. */
export function refuseNestedField(
  issues: readonly z.core.$ZodIssue[],
  field: string,
  code: string,
  shape: string,
): void {
  if (!issues.some((i) => i.path[0] === field)) return;
  const rows: Refusal[] = issues.map((i) =>
    i.path[0] === field
      ? { code, path: jsonPointer(i.path), detail: `${i.message}. \`${field}\` is ${shape}` }
      : { code: 'BAD_REQUEST', path: jsonPointer(i.path), detail: i.message },
  );
  const faults = issues.map((i) => `at ${jsonPointer(i.path)}, ${i.message}`).join('; ');
  const count = issues.length === 1 ? 'one fault' : `${issues.length} faults`;
  const detail = `The body has ${count}: ${faults}. \`${field}\` is ${shape}`;
  throw new RefusalError(rows, 'BAD_REQUEST', detail);
}

// the API contract reads a route's inputs off its middleware, not off a second description
export const zValidator = ((...args: Args) => {
  const [target, declaredSchema, hook, ...rest] = args;
  const schema = target === 'query' ? strictQuery(declaredSchema) : declaredSchema;
  const shape = (hook && shapes.get(hook)) ?? (hook ? null : { code: 'BAD_REQUEST' });
  // a route's own hook answers first; one that lets a failure through gets the shared answer
  const answer = (async (r: Failed, c: Context) => {
    const own = shape ? undefined : await (hook as (r: Failed, c: Context) => unknown)(r, c);
    if (own !== undefined || r.success) return own;
    const unknown =
      target === 'query' && r.error
        ? unknownQueryKeys(schema, r.error, hook ? elsewhere.get(hook) : undefined)
        : null;
    throw unknown ?? inputRefusal(r.error, shape ?? { code: 'BAD_REQUEST' });
  }) as Hook;
  const middleware = honoZodValidator(target, schema, answer, ...rest);
  const guarded = args[0] === 'json' ? refuseUndeclaredBodyType(middleware) : middleware;
  declared.set(guarded, { target, schema });
  return guarded;
}) as typeof honoZodValidator;

/**
 * The query of a read that takes none. A key sent to it is refused by name, saying the route takes
 * no query parameters, rather than dropped, and the contract marks the operation's query closed.
 */
export const noQuery = zValidator('query', z.strictObject({}));

const JSON_TYPE = /^application\/([a-z0-9.+-]*\+)?json(\s*;|$)/i;

// hono's json validator reads a body of any other content type as `{}`, so an
// all-optional schema would answer 200 having read nothing; a body that is there and is not
// declared JSON is refused by name instead.
// A JSON-typed request with no body (a DELETE sent by most clients, a POST with nothing to say)
// is read as `{}`, the same as hono reads a body with no content type, so the route's schema
// decides it: a route taking an empty object takes it, and one needing a field refuses by naming
// that field, never with hono's bare "Malformed JSON in request body". A body that is there and
// is not JSON is refused naming the route.
function refuseUndeclaredBodyType<M extends MiddlewareHandler>(middleware: M): M {
  return (async (c: Context, next: Next) => {
    const type = c.req.header('content-type') ?? '';
    const text = c.req.raw.body === null ? '' : await c.req.text();
    if (!JSON_TYPE.test(type)) {
      if (text.length > 0) {
        throw new HTTPException(415, {
          message:
            `${c.req.method} ${c.req.routePath} takes a JSON body, and this one was sent as ` +
            `${type ? `\`${type}\`` : 'no content type'}; send it with Content-Type: application/json.`,
          cause: { code: 'BODY_NOT_JSON', details: { contentType: type || null } },
        });
      }
      return middleware(c, next);
    }
    if (text.trim() === '') {
      // hono reads json() off the cached text, so this is the body every reader after us sees
      // hono types the cache as the body but stores the promise of it (request.ts #cachedBody)
      (c.req.bodyCache as Record<string, unknown>).text = Promise.resolve('{}');
    } else {
      try {
        JSON.parse(text);
      } catch {
        // the parser's own message quotes the body, which may carry a secret; it is not echoed
        throw new HTTPException(400, {
          message: `${c.req.method} ${c.req.routePath} takes a JSON body, and this one does not parse as JSON.`,
          cause: { code: 'BAD_REQUEST' },
        });
      }
    }
    return middleware(c, next);
  }) as M;
}

// a body no zod schema can hold (multipart, raw bytes, a signed payload) is still declared,
// so the contract names its media type and the generator can tell it from a body read in secret
export function rawBody(
  contentType: string,
  description: string,
  { required = true }: { required?: boolean } = {},
): MiddlewareHandler {
  const middleware: MiddlewareHandler = async (_c, next) => {
    await next();
  };
  declaredRaw.set(middleware, { contentType, description, required });
  return middleware;
}

/** A bad body is 400 naming both the valid shape (`hint`) and each field that broke it. */
export function strictBody<T extends z.ZodType>(schema: T, hint: string) {
  return zValidator('json', schema, invalid(`invalid body: ${hint}`));
}
