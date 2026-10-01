import { zValidator as honoZodValidator } from '@hono/zod-validator';
import type { MiddlewareHandler } from 'hono';

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
  declared.set(middleware, { target: args[0], schema: args[1] });
  return middleware;
}) as typeof honoZodValidator;

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
