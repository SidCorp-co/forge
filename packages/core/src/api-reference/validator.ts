import { zValidator as honoZValidator } from '@hono/zod-validator';
import type { MiddlewareHandler } from 'hono';
import type { ZodType } from 'zod';

/** What a route's input validator was built from, which the mounted middleware no longer shows. */
export type ValidatorDeclaration = {
  readonly target: 'param' | 'query' | 'json' | 'form' | 'header' | 'cookie';
  readonly schema: ZodType;
  readonly hook: ((...args: never[]) => unknown) | null;
  readonly enforced?: boolean;
};

export const validatorDeclarations = new WeakMap<object, ValidatorDeclaration>();

/** `@hono/zod-validator`'s `zValidator`, unchanged in what it answers, that also records what it was built from. */
export const zValidator: typeof honoZValidator = ((
  target: ValidatorDeclaration['target'],
  schema: ZodType,
  hook?: ValidatorDeclaration['hook'],
  options?: unknown,
) => {
  const middleware = (honoZValidator as (...args: unknown[]) => MiddlewareHandler)(
    target,
    schema,
    hook ?? undefined,
    options,
  );
  validatorDeclarations.set(middleware, { target, schema, hook: hook ?? null });
  return middleware;
}) as typeof honoZValidator;

/** Declares the schema a handler parses an input with itself; the middleware passes every request through. */
export function declaresInput(
  target: ValidatorDeclaration['target'],
  schema: ZodType,
): MiddlewareHandler {
  const middleware: MiddlewareHandler = async (_c, next) => next();
  validatorDeclarations.set(middleware, { target, schema, hook: null, enforced: false });
  return middleware;
}
