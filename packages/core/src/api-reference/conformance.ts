import type { MiddlewareHandler } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { matchedRoutes } from 'hono/route';
import { type ZodType, z } from 'zod';
import { env } from '../config/env.js';
import type { Reference } from './build.js';
import type { OperationDeclaration } from './describe.js';
import { renderSchema } from './schema.js';

type Mismatch = { readonly status: number; readonly what: string };

const wire = new WeakMap<ZodType, ZodType>();

/** `#/components/schemas/X`, which the document writes, as `#/$defs/X`, which a schema read alone holds. */
function toDefsRefs(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(toDefsRefs);
  if (node === null || typeof node !== 'object') return node;
  return Object.fromEntries(
    Object.entries(node).map(([key, child]) => [
      key,
      key === '$ref' && typeof child === 'string'
        ? child.replace('#/components/schemas/', '#/$defs/')
        : toDefsRefs(child),
    ]),
  );
}

/**
 * The schema a JSON body is checked against: the declared one as JSON Schema and back, so a `Date`
 * a handler sends is read as the string it became on the wire.
 */
function wireSchema(schema: ZodType): ZodType {
  let held = wire.get(schema);
  if (!held) {
    const rendered = renderSchema(schema, 'output');
    held = z.fromJSONSchema(toDefsRefs({ ...rendered.schema, $defs: rendered.defs }) as never);
    wire.set(schema, held);
  }
  return held;
}

/** What is wrong with an answer, judged against the descriptor and the error codes the route can give. */
export function judgeAnswer(
  declaration: OperationDeclaration | undefined,
  errors: ReadonlyMap<number, ReadonlySet<string>> | undefined,
  status: number,
  body: unknown,
): Mismatch | null {
  if (!declaration) return { status, what: 'the route declares no answers at all' };
  const declared = declaration.responses[status];
  if (status >= 400) {
    const code = (body as { code?: unknown } | null)?.code;
    const known = errors?.get(status);
    if (!known)
      return { status, what: `status ${status} is not an error status the route can give` };
    if (typeof code !== 'string' || !known.has(code)) {
      return {
        status,
        what: `error code ${String(code)} is not one the route declares for ${status} (${[...known].join(', ')})`,
      };
    }
    return null;
  }
  if (!declared) return { status, what: `status ${status} is not declared by the route` };
  if (declared.kind !== 'json') return null;
  const parsed = wireSchema(declared.schema).safeParse(body);
  if (parsed.success) return null;
  const issue = parsed.error.issues[0];
  return {
    status,
    what: `the body does not match the declared schema at ${issue?.path.join('.') || '(root)'}: ${issue?.message}`,
  };
}

/**
 * Makes each JSON answer under `/api` answer to the schema its route declares, when
 * `RESPONSE_CONFORMANCE=1`. A mismatch fails the request with a 500 that names the route, the
 * status and the field, so a run that drives the routes against a real database cannot pass while a
 * handler sends a body its reference does not describe. It reads nothing and changes nothing when off.
 */
export function responseConformance(reference: () => Promise<Reference>): MiddlewareHandler {
  return async (c, next) => {
    await next();
    if (env.RESPONSE_CONFORMANCE !== '1') return;
    if (!c.res.headers.get('content-type')?.includes('application/json')) return;
    const route = matchedRoutes(c)
      .filter((m) => m.method !== 'ALL')
      .at(-1);
    if (!route) return;
    const key = `${route.method} ${route.path}`;
    const { routes, errors } = await reference();
    const entry = routes.find((r) => r.key === key);
    if (!entry) return;
    const body = await c.res
      .clone()
      .json()
      .catch(() => undefined);
    const mismatch = judgeAnswer(entry.operations[0], errors.get(key), c.res.status, body);
    if (!mismatch) return;
    throw new HTTPException(500, {
      message: `response conformance: ${key} answered ${mismatch.status} and ${mismatch.what}`,
      cause: { code: 'RESPONSE_NOT_AS_DECLARED', details: { route: key, ...mismatch } },
    });
  };
}
