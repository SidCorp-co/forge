import { zValidator as honoZValidator } from '@hono/zod-validator';
import type { Context, MiddlewareHandler } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { type ZodType, z } from 'zod';
import { isBareRefusal } from '../../lib/refusal-sentence.js';
import { fieldsPolicy, refusesItself, unknownFields } from '../../lib/unknown-fields.js';
import { schemaRefusalWords, schemaRefused } from '../../lib/zod-sentences.js';

/** What a route's input validator was built from, which the mounted middleware no longer shows. */
export type ValidatorDeclaration = {
  readonly target: 'param' | 'query' | 'json' | 'form' | 'header' | 'cookie';
  readonly schema: ZodType;
  readonly hook: ((...args: never[]) => unknown) | null;
  readonly enforced?: boolean;
};

export const validatorDeclarations = new WeakMap<object, ValidatorDeclaration>();

type Parsed = { success: boolean; error?: z.core.$ZodError };
type Hook = (result: Parsed, c: Context) => unknown;

/** The parse's own issues as sentences, and its details with the values each fixed-set field takes. */
function inWords(error: z.core.$ZodError, details: unknown): { message: string; details: unknown } {
  const { sentences, accepted } = schemaRefusalWords(error.issues, {
    valuesAre: 'listed in details.accepted',
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
function worded(thrown: unknown, error: z.core.$ZodError): unknown {
  if (!(thrown instanceof HTTPException) || thrown.status >= 500) return thrown;
  if (!isBareRefusal(thrown.message)) return thrown;
  const cause = (thrown.cause ?? {}) as { code?: unknown; details?: unknown };
  const { message, details } = inWords(error, cause.details);
  return new HTTPException(thrown.status, { message, cause: { ...cause, details } });
}

/** A refusal a hook answered itself, re-worded the same way; any other answer passes untouched. */
async function wordedAnswer(answered: Response, error: z.core.$ZodError): Promise<Response> {
  if (answered.status < 400 || answered.status >= 500) return answered;
  if (!answered.headers.get('content-type')?.includes('application/json')) return answered;
  const body = (await answered
    .clone()
    .json()
    .catch(() => null)) as Record<string, unknown> | null;
  if (!body || typeof body.message !== 'string' || !isBareRefusal(body.message)) return answered;
  const { message, details } = inWords(error, body.details);
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
function sentenced(hook: Hook | undefined): Hook {
  return async (result, c) => {
    if (result.success || !result.error) return hook?.(result, c);
    let answered: unknown;
    try {
      answered = await hook?.(result, c);
    } catch (thrown) {
      throw worded(thrown, result.error);
    }
    if (answered instanceof Response) return wordedAnswer(answered, result.error);
    if (answered && typeof answered === 'object' && 'response' in answered) return answered;
    throw schemaRefused(result.error);
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
  const refusing = sentenced((hook ?? undefined) as Hook | undefined);
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
function unknownFieldsRefused(keys: string[]): HTTPException {
  const { sentences } = schemaRefusalWords([{ code: 'unrecognized_keys', keys, path: [] }], {
    valuesAre: 'listed in details.accepted',
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
      if (keys.length > 0) throw unknownFieldsRefused(keys);
    }
    return next();
  };
  validatorDeclarations.set(middleware, { target, schema, hook: null, enforced: false });
  return middleware;
}
