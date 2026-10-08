import { zValidator as honoZodValidator } from '@hono/zod-validator';
import type { Context, MiddlewareHandler, Next } from 'hono';
import { HTTPException } from 'hono/http-exception';
import type { z } from 'zod';
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

function unknownQueryKeys(schema: unknown, error: z.core.$ZodError): HTTPException | null {
  const unknown = [
    ...new Set(error.issues.flatMap((i) => (i.code === 'unrecognized_keys' ? i.keys : []))),
  ];
  if (unknown.length === 0) return null;
  const shape = (schema as { shape?: Record<string, unknown> }).shape;
  const takes = shape ? ` This route takes: ${Object.keys(shape).sort().join(', ')}.` : '';
  const rows: Refusal[] = [
    ...unknown.map((key) => ({
      code: 'UNKNOWN_QUERY_PARAMETER',
      path: jsonPointer([key]),
      detail: `\`${key}\` is not a query parameter of this route.${takes}`,
    })),
    ...error.issues
      .filter((i) => i.code !== 'unrecognized_keys')
      .map((i) => ({ code: 'BAD_REQUEST', path: jsonPointer(i.path), detail: i.message })),
  ];
  const named = unknown.map((key) => `\`${key}\``).join(', ');
  return new HTTPException(400, {
    message: `Unknown query parameter${unknown.length > 1 ? 's' : ''}: ${named}.${takes}`,
    cause: { code: 'UNKNOWN_QUERY_PARAMETER', details: rows },
  });
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
    const issues = r.error.issues;
    if (!issues.some((i) => i.path[0] === field)) return;
    const sent = typeof r.data === 'object' && r.data !== null ? Reflect.get(r.data, field) : null;
    const rows: Refusal[] = [
      { code, path: jsonPointer([field]), detail: `\`${field}\` is ${sentAs(sent)}. ${shape}` },
      ...issues
        .filter((i) => i.path[0] !== field)
        .map((i) => ({ code: 'BAD_REQUEST', path: jsonPointer(i.path), detail: i.message })),
    ];
    throw new RefusalError(rows, 'BAD_REQUEST');
  }) as Hook;
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
    const unknown = target === 'query' && r.error ? unknownQueryKeys(schema, r.error) : null;
    throw unknown ?? inputRefusal(r.error, shape ?? { code: 'BAD_REQUEST' });
  }) as Hook;
  const middleware = honoZodValidator(target, schema, answer, ...rest);
  const guarded = args[0] === 'json' ? refuseUndeclaredBodyType(middleware) : middleware;
  declared.set(guarded, { target, schema });
  return guarded;
}) as typeof honoZodValidator;

const JSON_TYPE = /^application\/([a-z0-9.+-]*\+)?json(\s*;|$)/i;

// hono's json validator reads a body of any other content type as `{}`, so an
// all-optional schema would answer 200 having read nothing; a body that is there and is not
// declared JSON is refused by name instead
function refuseUndeclaredBodyType<M extends MiddlewareHandler>(middleware: M): M {
  return (async (c: Context, next: Next) => {
    const type = c.req.header('content-type') ?? '';
    if (!JSON_TYPE.test(type) && c.req.raw.body !== null && (await c.req.text()).length > 0) {
      throw new HTTPException(415, {
        message:
          `${c.req.method} ${c.req.routePath} takes a JSON body, and this one was sent as ` +
          `${type ? `\`${type}\`` : 'no content type'}; send it with Content-Type: application/json.`,
        cause: { code: 'BODY_NOT_JSON', details: { contentType: type || null } },
      });
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
