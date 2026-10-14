import { findTargetHandler } from 'hono/utils/handler';
import { type Refusal, refusalsOf, takesBearer } from '../../middleware/declarations.js';
import { type OperationDeclaration, operationDeclarations } from '../declare/describe.js';
import { type ValidatorDeclaration, validatorDeclarations } from '../declare/validator.js';

/** One route the composed app serves, with everything declared on the way to its handler. */
export type RouteEntry = {
  /** `GET /api/issues/:id`. */
  readonly key: string;
  readonly method: string;
  /** Hono's path, `:name` segments and all. */
  readonly path: string;
  /** The route's own handler, the last one registered for this method and path. */
  readonly handler: object;
  readonly validators: readonly ValidatorDeclaration[];
  readonly operations: readonly OperationDeclaration[];
  /** What every gate in the chain that runs for this request can refuse with. */
  readonly refusals: readonly Refusal[];
  /** Whether a gate that runs for this request turns a missing or invalid bearer away. */
  readonly takesBearer: boolean;
  /** Why the chain could not be read, or null when it was. */
  readonly unread: string | null;
};

type RouteRecord = { method: string; path: string; handler: unknown };

/** What the reference reads off a Hono app: its route table and its router. */
export type RouteSource = {
  readonly routes: readonly RouteRecord[];
  readonly router: unknown;
};
type MatchedRoute = [[unknown, RouteRecord], unknown];
type RouterWithMatch = {
  match: (method: string, path: string) => [MatchedRoute[], ...unknown[]];
};

/** Whether a route answers `method` at `path`: a record of method `ALL` is a gate, not a route. HEAD is GET. */
export function servesRoute(app: RouteSource, method: string, path: string): boolean {
  const upper = method.toUpperCase();
  const [matched] = (app.router as RouterWithMatch).match(upper === 'HEAD' ? 'GET' : upper, path);
  return matched.some(([[, record]]) => record.method !== 'ALL');
}

const SAMPLES = ['00000000-0000-4000-8000-000000000000', '1', 'x'];

/** A path a request could take to this route: each `:name` gets a value, each `*` a segment. */
function samplePath(path: string, sample: string): string {
  return path.replace(/:[A-Za-z0-9_]+(\{[^}]*\})?\??/g, sample).replace(/\*/g, 'x');
}

/**
 * Every route of the composed app, read off its route table and router. The chain runs up to the
 * route's own handler: a gate registered after it never runs, as the handler answers without `next`.
 */
export function readRoutes(app: RouteSource): RouteEntry[] {
  const own = new Map<string, RouteRecord[]>();
  for (const route of app.routes) {
    if (route.method === 'ALL') continue;
    const key = `${route.method} ${route.path}`;
    own.set(key, [...(own.get(key) ?? []), route]);
  }
  const router = app.router as RouterWithMatch;
  const entries: RouteEntry[] = [];
  for (const [key, records] of own) {
    const last = records[records.length - 1];
    if (!last) continue;
    const method = last.method;
    const path = last.path;
    let chain: object[] | null = null;
    for (const sample of SAMPLES) {
      const [matched] = router.match(method, samplePath(path, sample));
      const handlers = matched
        .filter(
          ([[, record]]) => record.method === 'ALL' || `${record.method} ${record.path}` === key,
        )
        .map(([[handler]]) => handler as object);
      const own = handlers.indexOf(last.handler as object);
      if (own >= 0) {
        chain = handlers.slice(0, own + 1);
        break;
      }
    }
    const targets = (chain ?? (records.map((r) => r.handler) as object[])).map(
      (h) => findTargetHandler(h as never) as object,
    );
    const refusals = targets.flatMap((h) => refusalsOf(h));
    entries.push({
      key,
      method,
      path,
      handler: findTargetHandler(last.handler as never) as object,
      validators: targets.flatMap((h) => validatorDeclarations.get(h) ?? []),
      operations: targets.flatMap((h) => operationDeclarations.get(h) ?? []),
      refusals,
      takesBearer: takesBearer(refusals),
      unread:
        chain === null
          ? `no request path reaches ${key} through the router (tried ${SAMPLES.length} sample values)`
          : null,
    });
  }
  return entries.sort((a, b) =>
    a.path === b.path ? a.method.localeCompare(b.method) : a.path.localeCompare(b.path),
  );
}
