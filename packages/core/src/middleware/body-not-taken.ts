import type { Context, MiddlewareHandler } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { matchedRoutes } from 'hono/route';
import { findTargetHandler } from 'hono/utils/handler';
import {
  bodyTakenAsSent,
  unknownFieldsRefused,
  validatorDeclarations,
} from '../api-reference/declare/validator.js';

const WRITES = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/** What the API reference states for a write route that declares no body (ISS-1421 r16). */
export const BODY_NOT_TAKEN_WHEN = 'the request carries a body, and this call takes none';

/** The handlers of the route that answers this request, its gates mounted for every path aside. */
function ownHandlers(c: Context): object[] | null {
  const matched = matchedRoutes(c);
  const route = matched.find((r) => r.method !== 'ALL');
  if (!route) return null;
  return matched
    .filter((r) => r.method === route.method && r.path === route.path)
    .map((r) => findTargetHandler(r.handler as never) as object);
}

function takesABody(handlers: readonly object[]): boolean {
  return handlers.some((h) => {
    const target = validatorDeclarations.get(h)?.target;
    return target === 'json' || target === 'form' || bodyTakenAsSent.has(h);
  });
}

/** The fields a body names, `[]` for one that is not a JSON object, null for none at all. */
async function sentFields(c: Context): Promise<string[] | null> {
  if (c.req.header('content-length') === '0' || !c.req.raw.body) return null;
  const text = (await c.req.text()).trim();
  if (text === '') return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return [];
  }
  if (parsed === null) return null;
  if (typeof parsed !== 'object' || Array.isArray(parsed)) return [];
  const keys = Object.keys(parsed);
  return keys.length > 0 ? keys : null;
}

/**
 * A write route that declares no body refuses one, naming each field, before any gate or handler
 * runs: a pairing code asked for one minute was minted for ten while the field was dropped
 * unread. An empty body, `{}` and `null` are no body. A route that reads its own body says why with
 * `takesBodyAsSent`.
 */
export function refuseBodyNotTaken(): MiddlewareHandler {
  return async (c, next) => {
    if (!WRITES.has(c.req.method)) return next();
    const handlers = ownHandlers(c);
    if (!handlers || takesABody(handlers)) return next();
    const fields = await sentFields(c);
    if (fields === null) return next();
    if (fields.length > 0) throw unknownFieldsRefused(fields);
    throw new HTTPException(400, {
      message: 'This call takes no body.',
      cause: { code: 'BAD_REQUEST', details: { takesNoBody: true } },
    });
  };
}
