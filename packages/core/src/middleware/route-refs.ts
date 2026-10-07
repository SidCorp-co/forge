import type { Context, Hono, MiddlewareHandler } from 'hono';
import { refuser } from '../lib/refusal.js';
import { type AuthVars, requireUserOrDevice } from './auth.js';

/**
 * A page holds a project's slug and an issue's display key off its URL before it holds either uuid.
 * Every project-scoped route accepts the slug in place of the id (`/api/projects/<slug>/…` and
 * `?projectId=<slug>`), and every issue route the display key (`/api/issues/ISS-12/…?projectId=…`):
 * the reference is resolved once, here, and the request is routed as if it had named the uuid, so
 * the route's own gate and access check run exactly as they do for the id. A reference that names
 * nothing is refused by name, after the caller is authenticated, never routed as a guess.
 */
export interface RouteRefSources {
  projectIdOfSlug(slug: string): Promise<string | null>;
  issueIdOfKey(key: string, projectId: string): Promise<string | null>;
  /** Throws the named refusal for a key `issueIdOfKey` could not resolve, once `userId` is shown to read the project. */
  refuseIssueKey(key: string, projectId: string, userId: string | undefined): Promise<void>;
}

let sources: RouteRefSources | null = null;

/** The projects and issues domains answer what a slug and a key name; the HTTP door provides them at boot. */
export function provideRouteRefSources(provided: RouteRefSources): void {
  sources = provided;
}

function sourcesOf(): RouteRefSources {
  if (!sources) {
    throw new Error(
      'route refs: no source was provided, so a slug or display key cannot be resolved; the process entry calls provideRouteRefSources before it serves',
    );
  }
  return sources;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SLUG = /^[a-z0-9-]{1,64}$/;
const ISSUE_KEY = /^(?:[A-Za-z][A-Za-z0-9]{1,5}-)?\d{1,10}$/;

/** Set on a request whose reference resolved to nothing; read only by {@link refuseUnresolvedRefs}. */
const UNRESOLVED_HEADER = 'x-forge-unresolved-ref';

type Unresolved =
  | { kind: 'project'; slug: string }
  | { kind: 'issue'; key: string; projectId: string };

const lookupMs = new WeakMap<Request, number>();

/** The time spent resolving this request's references before it was routed, if any were. */
export function routeRefMs(c: Context): number | undefined {
  return lookupMs.get(c.req.raw);
}

const refuse = refuser('PROJECT_SLUG_UNKNOWN');

type Dispatch = Hono['fetch'];

/**
 * Wraps the app's dispatch: a Hono middleware runs after routing has chosen its handlers, so a
 * reference has to be resolved before the router sees the path. Paths under `/api/projects/` that a
 * route spells literally (`/api/projects/health`) are never read as a slug.
 */
export function resolvingRouteRefs(app: Hono<never>, dispatch: Dispatch): Dispatch {
  let literals: ReadonlySet<string> | null = null;
  const literalPaths = () => {
    literals ??= new Set(
      app.routes
        .map((r) => r.path)
        .filter((p) => p.startsWith('/api/projects/') && !p.includes(':') && !p.includes('*')),
    );
    return literals;
  };
  return async (req, env, ctx) => dispatch(await resolveRouteRefs(req, literalPaths), env, ctx);
}

async function resolveRouteRefs(
  req: Request,
  literalPaths: () => ReadonlySet<string>,
): Promise<Request> {
  const raw = req.url;
  const spoofed = req.headers.has(UNRESOLVED_HEADER);
  if (
    !spoofed &&
    !raw.includes('/api/projects/') &&
    !raw.includes('/api/issues/') &&
    !raw.includes('projectId=')
  ) {
    return req;
  }
  const url = new URL(raw);
  const segments = url.pathname.split('/');
  const started = performance.now();
  const projectIds = new Map<string, string | null>();
  const projectIdOf = async (slug: string) => {
    if (!projectIds.has(slug)) projectIds.set(slug, await sourcesOf().projectIdOfSlug(slug));
    return projectIds.get(slug) ?? null;
  };
  let unresolved: Unresolved | null = null;
  let changed = false;

  const queryRef = url.searchParams.get('projectId');
  let projectId = queryRef;
  if (queryRef && !UUID.test(queryRef) && SLUG.test(queryRef)) {
    projectId = await projectIdOf(queryRef);
    if (projectId) {
      url.searchParams.set('projectId', projectId);
      changed = true;
    } else {
      unresolved = { kind: 'project', slug: queryRef };
    }
  }

  const head = segments[3];
  if (segments[1] === 'api' && head && !UUID.test(head)) {
    if (segments[2] === 'projects' && SLUG.test(head) && !literalPaths().has(url.pathname)) {
      const id = await projectIdOf(head);
      if (id) {
        segments[3] = id;
        changed = true;
      } else {
        unresolved ??= { kind: 'project', slug: head };
      }
    } else if (
      segments[2] === 'issues' &&
      ISSUE_KEY.test(head) &&
      projectId &&
      UUID.test(projectId)
    ) {
      const id = await sourcesOf().issueIdOfKey(head, projectId);
      if (id) {
        segments[3] = id;
        changed = true;
      } else {
        unresolved ??= { kind: 'issue', key: head, projectId };
      }
    }
  }

  if (!changed && !unresolved && !spoofed) return req;
  url.pathname = segments.join('/');
  const next = new Request(url, req);
  next.headers.delete(UNRESOLVED_HEADER);
  if (unresolved) next.headers.set(UNRESOLVED_HEADER, JSON.stringify(unresolved));
  if (changed || unresolved) lookupMs.set(next, performance.now() - started);
  return next;
}

/**
 * Refuses a request whose reference named nothing: the caller is authenticated as any route would
 * (so a stranger learns nothing a 401 does not say), then told which reference failed and why.
 */
export function refuseUnresolvedRefs(): MiddlewareHandler<{ Variables: AuthVars }> {
  const authenticate = requireUserOrDevice();
  return async (c, next) => {
    const raw = c.req.header(UNRESOLVED_HEADER);
    if (!raw) return next();
    const unresolved = JSON.parse(raw) as Unresolved;
    let refusal: unknown = null;
    await authenticate(c, async () => {
      try {
        if (unresolved.kind === 'project') {
          throw refuse(
            'PROJECT_SLUG_UNKNOWN',
            `no project has the slug \`${unresolved.slug}\`; a project is named by its uuid or its slug`,
          );
        }
        await sourcesOf().refuseIssueKey(unresolved.key, unresolved.projectId, c.get('userId'));
      } catch (err) {
        refusal = err;
        return;
      }
      await next();
    });
    if (refusal) throw refusal;
  };
}
