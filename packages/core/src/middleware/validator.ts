import { zValidator as honoZValidator } from '@hono/zod-validator';
import type { MiddlewareHandler } from 'hono';
import type { ZodType } from 'zod';

/**
 * What a route's input validator was built from. The middleware `zValidator` returns closes over
 * its schema and hook, so once it is mounted the API reference cannot read either back; this
 * registry is how it does.
 */
export type ValidatorDeclaration = {
  readonly target: 'param' | 'query' | 'json' | 'form' | 'header' | 'cookie';
  readonly schema: ZodType;
  /** The hook the route passed, or null where the library's own 400 answers a refusal. */
  readonly hook: ((...args: never[]) => unknown) | null;
  /** False for an input the handler parses itself and only declares here. */
  readonly enforced?: boolean;
};

const declared = new WeakMap<object, ValidatorDeclaration>();

/** The input a validator middleware was declared with, or undefined for any other handler. */
export function validatorDeclarationOf(handler: object): ValidatorDeclaration | undefined {
  return declared.get(handler);
}

/**
 * `@hono/zod-validator`'s `zValidator`, unchanged in what it validates and answers, that also
 * records its target, schema and hook for the API reference. Every route validates its input
 * through this one door, so a request schema is the schema the handler validates with and never a
 * second copy kept beside it.
 */
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
  declared.set(middleware, { target, schema, hook: hook ?? null });
  return middleware;
}) as typeof honoZValidator;

/**
 * Declares an input the handler reads itself, beside the validator it does not run: the schema is
 * the constant the handler parses with, so the reference states what the handler enforces. The
 * middleware passes every request through unchanged.
 */
export function declaresInput(
  target: ValidatorDeclaration['target'],
  schema: ZodType,
): MiddlewareHandler {
  const middleware: MiddlewareHandler = async (_c, next) => next();
  declared.set(middleware, { target, schema, hook: null, enforced: false });
  return middleware;
}
