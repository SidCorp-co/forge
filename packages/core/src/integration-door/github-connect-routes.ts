/**
 * Routes for the GitHub App connect flow.
 *
 *   POST /:projectId/integrations/github/connect  → the manifest to POST to GitHub
 *   GET  /integrations/github/manifest-callback   → GitHub returns the code here
 *   GET  /integrations/github/installed           → GitHub returns installation_id here
 *
 * The two GETs are browser redirects from GitHub, so they carry the operator's
 * own session cookie and admit whom requireAuth admits. Everything they cannot
 * finish lands on the web Integrations page naming why (`?connect=<cause>`),
 * never as JSON on the API's origin: by the first callback GitHub has already
 * made the App, and a refusal nobody reads leaves it stranded there (FB-128).
 */

import type { GitHubConnectStrand, IntegrationRefusalCode } from '@forge/contracts/integrations';
import type { Context, MiddlewareHandler } from 'hono';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import {
  buildAppManifest,
  type ConnectState,
  type ConvertedApp,
  convertManifestCode,
  findConnectionOwningInstallation,
  listInstallationRepositories,
  manifestPostUrl,
  readConnectState,
  signConnectState,
} from '../integrations/github/index.js';
import {
  assertVaultConfigured,
  createConnection,
  decryptConnectionSecrets,
  type IntegrationConnectionRow,
  isVaultConfigured,
  listBindingsForProject,
  listConnectionsForPrincipalUser,
  notFound,
  resolveApiBaseUrl,
} from '../integrations/index.js';
import { SourceHostCallError } from '../integrations/source-host/index.js';
import { loadVisibleProjectIds } from '../lib/authz.js';
import { logger } from '../lib/logger.js';
import { refuser } from '../lib/refusal.js';
import {
  type AuthVars,
  assertEmailVerified,
  requireAuth,
  requireAuthOrLand,
} from '../middleware/auth.js';
import { badRequest } from '../middleware/route-errors.js';
import { zValidator } from '../middleware/zod-validator.js';
import {
  actorFor,
  can,
  orgResource,
  projectResource,
  requireCan,
  requireOrgCan,
} from '../permissions/index.js';
import { projectOrgHead } from '../projects/index.js';

const refuse = refuser<IntegrationRefusalCode>('INTEGRATION_REFUSED');

/** The projects the caller may administer, asked of can() one by one: the scope an install may resolve in. */
async function projectsAdministeredBy(userId: string): Promise<string[]> {
  const actor = actorFor(userId);
  const visible = await loadVisibleProjectIds(userId);
  const held = await Promise.all(
    visible.map((id) => can(actor, 'project.admin', projectResource(id))),
  );
  return visible.filter((_, i) => held[i]);
}

const connectQuerySchema = z.object({
  org: z.string().optional(),
  orgId: z.string().optional(),
  returnTo: z.literal('integrations').optional(),
});
const repositoriesQuerySchema = z.object({ connectionId: z.string().optional() });
// GitHub redirects to both and adds keys of its own (setup_action on an install)
const manifestCallbackQuerySchema = z.looseObject({
  code: z.string().optional(),
  state: z.string().optional(),
});
const installedQuerySchema = z.looseObject({
  installation_id: z.string().optional(),
  state: z.string().optional(),
});

/** What a stranded App can be named by: its slug and owner, read when its code was spent. */
type StrandedApp = Pick<ConvertedApp, 'slug' | 'owner'>;

/**
 * The web Integrations page, naming why GitHub's return could not finish and, where it is known,
 * the App GitHub made: `?connect=<cause>&app=<slug>&appOwner=<login>&appOrg=1`.
 */
function strandedAt(c: Context, cause: GitHubConnectStrand, app?: StrandedApp | null): Response {
  const q = new URLSearchParams({ connect: cause });
  if (app?.slug) q.set('app', app.slug);
  if (app?.owner) {
    q.set('appOwner', app.owner.login);
    if (app.owner.isOrg) q.set('appOrg', '1');
  }
  return c.redirect(`${webBaseUrl()}/integrations?${q.toString()}`);
}

/**
 * Spend a genuine, own return's code only to learn which App GitHub made, and drop the key it
 * comes with: the person it was made for may delete it or mint it a new key, but Forge was never
 * allowed to keep this one. Null when GitHub will not convert it.
 */
async function nameStrandedApp(code: string): Promise<StrandedApp | null> {
  try {
    const { slug, owner } = await convertManifestCode({ code });
    logger.info({ slug }, 'github: named a stranded App; its key was not kept');
    return { ...(slug ? { slug } : {}), ...(owner ? { owner } : {}) };
  } catch (err) {
    logger.warn({ err }, 'github: a stranded App could not be named');
    return null;
  }
}

/** Where a finished connect lands: the page it began on. */
function finishedAt(
  state: { returnTo?: ConnectState['returnTo'] | undefined; projectId: string },
  connectionId: string,
) {
  return state.returnTo === 'integrations'
    ? `${webBaseUrl()}/integrations?bind=${encodeURIComponent(connectionId)}`
    : `${webBaseUrl()}/projects/${state.projectId}/settings/integrations`;
}

// the admin check runs before the query is read, so a non-admin learns nothing from a 400
const projectAdmin: MiddlewareHandler<{ Variables: AuthVars }> = async (c, next) => {
  await requireCan(
    actorFor(c.get('userId')),
    'project.admin',
    projectResource(c.req.param('projectId') ?? ''),
  );
  await next();
};

export const githubConnectRoutes = new Hono<{ Variables: AuthVars }>();
githubConnectRoutes.use('*', requireAuth(), assertEmailVerified());

export const githubCallbackRoutes = new Hono<{ Variables: AuthVars }>();
// no session, or another person's, is not provably the person the App was made for: the return
// lands naming why and spends no code (`no_session` and `email_unverified` are of that group)
githubCallbackRoutes.use(
  '/integrations/github/*',
  requireAuthOrLand((c, why) => strandedAt(c, why)),
);

function stateSecret(): string {
  const secret = process.env.JWT_SECRET;
  if (!secret) throw new HTTPException(500, { message: 'JWT_SECRET is not configured' });
  return secret;
}

function webBaseUrl(): string {
  const base = process.env.APP_BASE_URL;
  if (!base) throw new HTTPException(500, { message: 'APP_BASE_URL is not configured' });
  return base;
}

function apiBaseUrl(): string {
  const base = resolveApiBaseUrl();
  if (!base) throw new HTTPException(500, { message: 'APP_BASE_URL is not configured' });
  return base;
}

/** The public origin this request reached core at, as the proxy in front of core reports it. */
function reachedOrigin(c: Context): string {
  const url = new URL(c.req.url);
  const proto = c.req.header('x-forwarded-proto')?.split(',')[0]?.trim();
  if (proto === 'https' || proto === 'http') url.protocol = `${proto}:`;
  const forwardedHost = c.req.header('x-forwarded-host')?.split(',')[0]?.trim();
  if (forwardedHost) url.host = forwardedHost;
  return url.origin;
}

/**
 * Where GitHub sends the browser back after creating and installing the App: the origin this
 * request reached core at, when it is one this core is configured to answer on — the API's own
 * (PUBLIC_API_BASE_URL) or the web's (APP_BASE_URL, where the web serves `/api` in front of core).
 * This request proves that origin routes `/api` to core, and it is the origin the person's session
 * rides on, so the return carries the session the callbacks admit. Insisting on the API's origin
 * refused every connect begun on a web that proxies `/api`, which is how forge-dev is served.
 */
function browserReturnOrigin(c: Context, api: string): string {
  const reached = reachedOrigin(c);
  const configured = [api, process.env.APP_BASE_URL]
    .filter((u): u is string => typeof u === 'string' && u.length > 0)
    .map((u) => new URL(u).origin);
  if (configured.includes(reached)) return reached;
  throw new HTTPException(500, {
    message:
      `This request reached core at ${reached}, which is not an origin this core is configured to answer on ` +
      `(${configured.join(', ')}). GitHub sends the browser back to the origin the request came from, so open ` +
      'Forge at one of those, or set PUBLIC_API_BASE_URL to the origin this core is served at.',
  });
}

/**
 * Which principal the App this flow is about to create will belong to.
 *
 * The App is named after the project, bound to it and used by its runners, so
 * an org project's App belongs to that org rather than to whoever pressed
 * Connect (ISS-1115). The refusal is taken HERE and not in the callback,
 * where a real App already exists on github.com and refusing would strand it.
 */
async function ownerOrgForProjectApp(args: {
  projectOrgId: string | null;
  asked: string | null;
  userId: string;
}): Promise<string | undefined> {
  if (args.asked && args.asked !== args.projectOrgId) {
    throw refuse(
      'ORG_MISMATCH',
      "org connection must belong to the project's own org — this project belongs to " +
        `${args.projectOrgId ?? 'no shared org'}, and the request named ${args.asked}.`,
    );
  }
  if (!args.projectOrgId) return undefined;
  // A GitHub App created here is owned by the project's org and reachable by every admin of the
  // project, so creating one takes org.admin there.
  await requireOrgCan(actorFor(args.userId), 'org.admin', orgResource(args.projectOrgId));
  return args.projectOrgId;
}

githubConnectRoutes.post(
  '/:projectId/integrations/github/connect',
  projectAdmin,
  zValidator('query', connectQuerySchema),
  async (c) => {
    const projectId = c.req.param('projectId');
    const userId = c.get('userId');
    assertVaultConfigured();

    const project = await projectOrgHead(projectId);
    if (!project) throw notFound('project');

    const query = c.req.valid('query');
    const org = query.org ?? null;
    const orgId = await ownerOrgForProjectApp({
      // A solo operator's org row is their PERSONAL one, and the connections
      // directory scopes such an org to `ownerType:'user'` — an App owned by it
      // would be invisible to its only admin. So: no shared owner.
      projectOrgId: project.orgIsPersonal ? null : project.orgId,
      asked: query.orgId ?? null,
      userId,
    });

    const api = apiBaseUrl();
    const returnTo = browserReturnOrigin(c, api);

    return c.json({
      postUrl: manifestPostUrl(org),
      state: signConnectState(stateSecret(), {
        projectId,
        userId,
        ...(orgId ? { orgId } : {}),
        ...(query.returnTo ? { returnTo: query.returnTo } : {}),
      }),
      manifest: buildAppManifest({
        appName: `Forge — ${project.name}`,
        webBaseUrl: webBaseUrl(),
        apiBaseUrl: api,
        returnBaseUrl: returnTo,
        projectSlug: project.slug,
      }),
    });
  },
);

/**
 * The App whose repositories this project's picker may list. Two grants, read
 * after the route has proved the caller an admin of the project, and neither a
 * fallback for the other — a connection under neither is refused.
 *
 *  - the project's own binding points at it, whatever principal owns it, and
 *    switched off or not, since a repick starts from a disconnected row.
 *    Binding it here already took somebody who could manage the connection
 *    plus an admin of this project, and listing the App's repositories is what
 *    the binding is for. Asking the caller's own principal INSTEAD is what
 *    answered every admin but one with `connection not found`.
 *  - the caller sees it as a principal: the create path, which lists before
 *    any binding to this project exists.
 */
async function githubConnectionForPicker(args: {
  projectId: string;
  userId: string;
  connectionId: string;
}): Promise<IntegrationConnectionRow | null> {
  const bound = (await listBindingsForProject(args.projectId)).find(
    (pair) => pair.binding.provider === 'github' && pair.connection.id === args.connectionId,
  );
  if (bound) return bound.connection;
  const owned = (await listConnectionsForPrincipalUser(args.userId)).find(
    (x) => x.id === args.connectionId && x.provider === 'github',
  );
  return owned ?? null;
}

githubConnectRoutes.get(
  '/:projectId/integrations/github/repositories',
  projectAdmin,
  zValidator('query', repositoriesQuerySchema),
  async (c) => {
    const projectId = c.req.param('projectId');
    const userId = c.get('userId');

    const { connectionId } = c.req.valid('query');
    if (!connectionId) throw badRequest({ connectionId: 'required' });

    const connection = await githubConnectionForPicker({ projectId, userId, connectionId });
    if (!connection) throw notFound('connection');

    const { appId, privateKey } = decryptConnectionSecrets<{
      appId?: string;
      privateKey?: string;
    }>(connection);
    if (!appId || !privateKey) throw badRequest({ connectionId: 'the App was never converted' });

    try {
      return c.json(await listInstallationRepositories({ appId, privateKey }));
    } catch (err) {
      if (!(err instanceof SourceHostCallError)) throw err;
      throw new HTTPException(502, {
        message: `${err.message}, so the repositories this App can see are unknown${err.detail ? `: ${err.detail}` : ''}`,
        cause: { code: 'GITHUB_REFUSED', details: { httpStatus: err.status } },
      });
    }
  },
);

githubCallbackRoutes.get(
  '/integrations/github/manifest-callback',
  zValidator('query', manifestCallbackQuerySchema),
  async (c) => {
    const { code, state: rawState } = c.req.valid('query');
    if (!code) return strandedAt(c, 'code_missing');
    if (!rawState) return strandedAt(c, 'state_missing');
    const read = readConnectState(stateSecret(), rawState);
    if (!read.ok && read.why === 'invalid') return strandedAt(c, 'state_invalid');
    const state = read.state;
    const userId = c.get('userId');
    if (state.userId !== userId) return strandedAt(c, 'state_other_user');

    // From here the state is genuine and this person's own, so a refusal may spend the code to
    // name the App it strands. Above, it may not: a forged or foreign return would make Forge
    // spend somebody else's App code.
    if (!read.ok) return strandedAt(c, 'state_expired', await nameStrandedApp(code));
    if (!(await can(actorFor(userId), 'project.admin', projectResource(state.projectId)))) {
      return strandedAt(c, 'not_admin', await nameStrandedApp(code));
    }
    if (!isVaultConfigured()) return strandedAt(c, 'vault_missing', await nameStrandedApp(code));

    let app: ConvertedApp;
    try {
      app = await convertManifestCode({ code });
    } catch (err) {
      logger.warn({ err, projectId: state.projectId }, 'github: the manifest code did not convert');
      return strandedAt(c, 'conversion_failed');
    }

    let connection: IntegrationConnectionRow;
    try {
      connection = await createConnection({
        ownerType: state.orgId ? 'org' : 'user',
        ownerId: state.orgId ?? userId,
        provider: 'github',
        displayName: app.slug ? `GitHub App ${app.slug}` : 'GitHub App',
        config: {},
        secrets: {
          appId: app.appId,
          privateKey: app.privateKey,
          webhookSecret: app.webhookSecret,
        },
      });
    } catch (err) {
      logger.error(
        { err, projectId: state.projectId, appId: app.appId },
        'github: saving the App failed',
      );
      return strandedAt(c, 'save_failed', app);
    }

    logger.info(
      { projectId: state.projectId, appId: app.appId, connectionId: connection.id },
      'github: app created from manifest',
    );

    if (!app.htmlUrl) return c.redirect(finishedAt(state, connection.id));
    // the install step carries the state on, so the return after it knows this connection and
    // the page the flow began on without guessing from the installation
    const onward = signConnectState(stateSecret(), { ...state, connectionId: connection.id });
    return c.redirect(`${app.htmlUrl}/installations/new?state=${encodeURIComponent(onward)}`);
  },
);

githubCallbackRoutes.get(
  '/integrations/github/installed',
  zValidator('query', installedQuerySchema),
  async (c) => {
    const query = c.req.valid('query');
    const installationId = Number(query.installation_id);
    const rawState = query.state;
    const userId = c.get('userId');

    if (!Number.isFinite(installationId) || installationId <= 0) {
      return strandedAt(c, 'install_missing');
    }
    const read = rawState ? readConnectState(stateSecret(), rawState) : null;
    if (read && !read.ok && read.why === 'invalid') return strandedAt(c, 'state_invalid');
    // an expired state still names the connection this person's flow created; the install itself
    // spends nothing, so it is read as theirs once the user matches
    const state = read ? read.state : null;
    if (state && state.userId !== userId) return strandedAt(c, 'state_other_user');

    const owner = state?.connectionId
      ? null
      : await findConnectionOwningInstallation({
          scope: { userId, administeredProjectIds: await projectsAdministeredBy(userId) },
          installationId,
        });
    const connectionId = state?.connectionId ?? owner?.connection.id ?? null;
    if (!connectionId) return strandedAt(c, 'install_unmatched');
    const projectId = state?.projectId ?? owner?.projectId ?? null;
    if (!projectId) {
      return c.redirect(finishedAt({ returnTo: 'integrations', projectId: '' }, connectionId));
    }
    if (!(await can(actorFor(userId), 'project.admin', projectResource(projectId)))) {
      return strandedAt(c, 'not_admin');
    }

    return c.redirect(finishedAt({ returnTo: state?.returnTo, projectId }, connectionId));
  },
);
