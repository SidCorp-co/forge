import type { Context, Hono, MiddlewareHandler } from 'hono';
import { verifyPat } from '../credentials/pat.js';
import { isPatLike } from '../credentials/pat-format.js';
import { tokenFence } from '../credentials/token-fence.js';
import { refuser } from '../lib/refusal.js';
import { type AuthVars, requireUserOrDevice } from './auth.js';
import { parseBearerHeader } from './bearer.js';
import { type NamedProject, refuseOutsideFence } from './pat-fence.js';

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
  /** The slug of each of these projects that exists, for a refusal naming projects by both. */
  projectSlugsOf(projectIds: readonly string[]): Promise<Map<string, string>>;
  issueIdOfKey(key: string, projectId: string): Promise<string | null>;
  /** Throws the named refusal for a key `issueIdOfKey` could not resolve, once `userId` is shown to read the project. */
  refuseIssueKey(key: string, projectId: string, userId: string | undefined): Promise<void>;
}

let sources: RouteRefSources | null = null;

/** The projects and issues domains answer what a slug and a key name; the HTTP door provides them at boot. */
export function provideRouteRefSources(provided: RouteRefSources): void {
  sources = provided;
}

/** What a project's slug and id name, for a door past routing that reads a project by either. */
export function projectNames(): Pick<RouteRefSources, 'projectIdOfSlug' | 'projectSlugsOf'> {
  return sourcesOf();
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
  | { kind: 'project'; slug: string; by: 'path' | 'query' }
  | { kind: 'issue'; key: string; projectId: string };

const lookupMs = new WeakMap<Request, number>();

/** The time spent resolving this request's references before it was routed, if any were. */
export function routeRefMs(c: Context): number | undefined {
  return lookupMs.get(c.req.raw);
}

const refuse = refuser('PROJECT_SLUG_UNKNOWN');

type Dispatch = Hono['fetch'];

let routed: Hono<never> | null = null;
let heads: ReadonlySet<string> | null = null;

/** The first segments under `/api/projects/` that a route spells literally, read from the router. */
function literalProjectHeads(): ReadonlySet<string> {
  if (!routed) {
    throw new Error(
      'route refs: no app is routed yet, so which slugs a project route can address is unknown; the process entry wraps app.fetch with resolvingRouteRefs before it serves',
    );
  }
  heads ??= new Set(
    routed.routes
      .map((r) => r.path.split('/'))
      .filter((s) => s[1] === 'api' && s[2] === 'projects' && s[3] && !/[:*]/.test(s[3]))
      .map((s) => s[3] as string),
  );
  return heads;
}

/**
 * Why no project route could address a project by `slug`, or null when one can: a uuid's shape is
 * read as the id, and a segment a route under `/api/projects/` spells literally is that route.
 */
export function unaddressableProjectSlug(slug: string): string | null {
  if (UUID.test(slug)) {
    return `it has a uuid's shape, so /api/projects/${slug} is read as a project id, never as this slug`;
  }
  if (literalProjectHeads().has(slug)) {
    return `/api/projects/${slug} is a route of its own, so no project route could address this project by its slug`;
  }
  return null;
}

/**
 * Wraps the app's dispatch: a Hono middleware runs after routing has chosen its handlers, so a
 * reference has to be resolved before the router sees the path. A segment under `/api/projects/`
 * that a route spells literally (`health`) is never read as a slug; no project may hold one
 * ({@link unaddressableProjectSlug}).
 */
export function resolvingRouteRefs(app: Hono<never>, dispatch: Dispatch): Dispatch {
  routed = app;
  heads = null;
  return async (req, env, ctx) => dispatch(await resolveRouteRefs(req), env, ctx);
}

async function resolveRouteRefs(req: Request): Promise<Request> {
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
      unresolved = { kind: 'project', slug: queryRef, by: 'query' };
    }
  }

  const head = segments[3];
  if (segments[1] === 'api' && head && !UUID.test(head)) {
    if (segments[2] === 'projects' && SLUG.test(head) && !literalProjectHeads().has(head)) {
      const id = await projectIdOf(head);
      if (id) {
        segments[3] = id;
        changed = true;
      } else {
        unresolved ??= { kind: 'project', slug: head, by: 'path' };
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
 * The project an unresolved reference names, as the fence reads it: the slug where it was one, the
 * project id the issue key was looked up under where it was a key.
 */
function namedBy(unresolved: Unresolved): NamedProject {
  return unresolved.kind === 'project'
    ? { by: unresolved.by, ref: unresolved.slug }
    : { by: 'query', ref: unresolved.projectId };
}

/**
 * A fenced credential naming a project outside its fence is refused PAT_PROJECT_OUTSIDE_FENCE here,
 * before the reference is said to name nothing (ISS-723 c2): the refusal reads the same whether the
 * project exists or not, so a fenced token cannot learn which slugs exist from a 404 beside a 403.
 * A box's checkout credential is admitted as a device past `requireUserOrDevice`, and a person's
 * token was fenced on the slug before it resolved (to nothing), so the fence is read off the bearer.
 */
async function refuseUnresolvedOutsideFence(c: Context, unresolved: Unresolved): Promise<void> {
  const bearer = parseBearerHeader(c);
  if (bearer.kind !== 'token' || !isPatLike(bearer.token)) return;
  const row = (await verifyPat(bearer.token))?.row;
  if (!row) return;
  await refuseOutsideFence({
    tokenId: row.id,
    fence: tokenFence(row),
    named: namedBy(unresolved),
    method: c.req.method,
    path: c.req.path,
  });
}

/**
 * Refuses a request whose reference named nothing: the caller is authenticated as any route would
 * (so a stranger learns nothing a 401 does not say), a fenced credential is held to its fence, then
 * the caller is told which reference failed and why.
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
        await refuseUnresolvedOutsideFence(c, unresolved);
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
