import { findTargetHandler } from 'hono/utils/handler';
import { type Refusal, refusalsOf } from '../middleware/declarations.js';
import { type ValidatorDeclaration, validatorDeclarationOf } from '../middleware/validator.js';
import { type OperationDeclaration, operationOf } from './describe.js';

/** One route the composed app serves, with everything declared on the way to its handler. */
export type RouteEntry = {
  /** `GET /api/issues/:id`, the key the route table and the pat-mount test both use. */
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

const SAMPLES = ['00000000-0000-4000-8000-000000000000', '1', 'x'];

/** A path a request could take to this route: each `:name` gets a value, each `*` a segment. */
function samplePath(path: string, sample: string): string {
  return path.replace(/:[A-Za-z0-9_]+(\{[^}]*\})?\??/g, sample).replace(/\*/g, 'x');
}

/**
 * Every route of the composed app, read off its own route table and its own router, so nothing
 * here is a parse of `index.ts` and a router nested with `.route()` is as visible as one mounted
 * directly. The chain a request would run is what the router matches for a path that reaches the
 * route, so a gate mounted with `use('/x/*')` is read as the route's, and a gate that does not
 * reach it is not.
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
      if (handlers.includes(last.handler as object)) {
        chain = handlers;
        break;
      }
    }
    const targets = (chain ?? (records.map((r) => r.handler) as object[])).map(
      (h) => findTargetHandler(h as never) as object,
    );
    entries.push({
      key,
      method,
      path,
      handler: findTargetHandler(last.handler as never) as object,
      validators: targets.flatMap((h) => validatorDeclarationOf(h) ?? []),
      operations: targets.flatMap((h) => operationOf(h) ?? []),
      refusals: targets.flatMap((h) => refusalsOf(h)),
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
