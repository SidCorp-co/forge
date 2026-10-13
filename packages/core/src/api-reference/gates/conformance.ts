import type { Context, MiddlewareHandler } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { matchedRoutes } from 'hono/route';
import { type ZodType, z } from 'zod';
import { env } from '../../config/env.js';
import type { OperationDeclaration } from '../declare/describe.js';
import { renderSchema } from '../declare/schema.js';
import type { Reference } from '../document/build.js';

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

/** The body `@hono/zod-validator` answers with when a validator has no hook: `{ success: false, error }`. */
function isLibraryRefusal(body: unknown): boolean {
  if (body === null || typeof body !== 'object') return false;
  const answer = body as { success?: unknown; error?: unknown; code?: unknown };
  return answer.success === false && answer.error !== undefined && answer.code === undefined;
}

/** What is wrong with an answer, judged against the descriptor and the error codes the route can give. */
export function judgeAnswer(
  declaration: OperationDeclaration | undefined,
  errors: ReadonlyMap<number, ReadonlySet<string>> | undefined,
  status: number,
  body: unknown,
  libraryDefault = false,
): Mismatch | null {
  if (!declaration) return { status, what: 'the route declares no answers at all' };
  const declared = declaration.responses[status];
  // A route that answers an error in its own shape (a liveness body, a JSON-RPC error) declares that
  // shape with json(...), and it is judged against it as any other body is.
  if (status >= 400 && declared?.kind !== 'json') {
    const code = (body as { code?: unknown } | null)?.code;
    if (libraryDefault && status === 400 && isLibraryRefusal(body)) return null;
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
 * The route whose handler gave the answer. Every route that matches the path is listed, in the
 * order it was registered, and the answer is the one `routeIndex` stopped at: `/projects/health`
 * and `/projects/:id` both match `/projects/health`, and the first to answer wins. Where a gate
 * ahead of the route refused the request, the route it guarded is the next one in the list.
 */
function responderOf(c: Context): { method: string; path: string } | undefined {
  const matched = matchedRoutes(c);
  const stopped = matched[c.req.routeIndex];
  if (stopped && stopped.method !== 'ALL') return stopped;
  return matched.slice(c.req.routeIndex + 1).find((m) => m.method !== 'ALL');
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
    const route = responderOf(c);
    if (!route) return;
    const key = `${route.method} ${route.path}`;
    const { routes, errors, libraryDefaults } = await reference();
    const entry = routes.find((r) => r.key === key);
    if (!entry) return;
    const body = await c.res
      .clone()
      .json()
      .catch(() => undefined);
    const mismatch = judgeAnswer(
      entry.operations[0],
      errors.get(key),
      c.res.status,
      body,
      libraryDefaults.has(key),
    );
    if (!mismatch) return;
    throw new HTTPException(500, {
      message: `response conformance: ${key} answered ${mismatch.status} and ${mismatch.what}`,
      cause: { code: 'RESPONSE_NOT_AS_DECLARED', details: { route: key, ...mismatch } },
    });
  };
}
