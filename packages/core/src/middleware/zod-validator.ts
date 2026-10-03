import { zValidator as honoZodValidator } from '@hono/zod-validator';
import type { Context, MiddlewareHandler, Next } from 'hono';
import { HTTPException } from 'hono/http-exception';
import type { z } from 'zod';
import { flatten } from './route-errors.js';

type Args = Parameters<typeof honoZodValidator>;

export type DeclaredInput = { target: Args[0]; schema: Args[1] };

export type DeclaredRawBody = { contentType: string; description: string; required: boolean };

const declared = new WeakMap<object, DeclaredInput>();
const declaredRaw = new WeakMap<object, DeclaredRawBody>();

export const declaredInputs: Pick<WeakMap<object, DeclaredInput>, 'get'> = declared;
export const declaredRawBodies: Pick<WeakMap<object, DeclaredRawBody>, 'get'> = declaredRaw;

// cm:why the API contract reads a route's inputs off its middleware, not off a second description
export const zValidator = ((...args: Args) => {
  const middleware = honoZodValidator(...args);
  const guarded = args[0] === 'json' ? refuseUndeclaredBodyType(middleware) : middleware;
  declared.set(guarded, { target: args[0], schema: args[1] });
  return guarded;
}) as typeof honoZodValidator;

const JSON_TYPE = /^application\/([a-z0-9.+-]*\+)?json(\s*;|$)/i;

// cm:guard hono's json validator reads a body of any other content type as `{}`, so an
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

// cm:why a body no zod schema can hold (multipart, raw bytes, a signed payload) is still declared,
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

/**
 * A domain write's JSON body: 400 `BAD_REQUEST` whose message carries the valid shape (`hint`) and
 * whose `details` name each field that was wrong (`route-errors.ts:flatten`), so neither the shape
 * nor the field is left for the caller to guess.
 */
export function strictBody<T extends z.ZodType>(schema: T, hint: string) {
  return zValidator('json', schema, (r) => {
    if (!r.success) {
      throw new HTTPException(400, {
        message: `invalid body: ${hint}`,
        cause: { code: 'BAD_REQUEST', details: flatten(r.error) },
      });
    }
  });
}
