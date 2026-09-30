import { zValidator as honoZodValidator } from '@hono/zod-validator';

type Args = Parameters<typeof honoZodValidator>;

export type DeclaredInput = { target: Args[0]; schema: Args[1] };

const declared = new WeakMap<object, DeclaredInput>();

export const declaredInputs: Pick<WeakMap<object, DeclaredInput>, 'get'> = declared;

// cm:why the API contract reads a route's inputs off its middleware, not off a second description
export const zValidator = ((...args: Args) => {
  const middleware = honoZodValidator(...args);
  declared.set(middleware, { target: args[0], schema: args[1] });
  return middleware;
}) as typeof honoZodValidator;
