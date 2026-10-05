/**
 * Routes for the GitHub App connect flow.
 *
 *   POST /:projectId/integrations/github/connect  → the manifest to POST to GitHub
 *   GET  /integrations/github/manifest-callback   → GitHub returns the code here
 *   GET  /integrations/github/installed           → GitHub returns installation_id here
 *
 * The two GETs are browser redirects from GitHub, so they carry the operator's
 * own session cookie and answer to the same auth as every other route.
 */

import type { IntegrationRefusalCode } from '@forge/contracts/integrations';
import type { Context, MiddlewareHandler } from 'hono';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import {
  buildAppManifest,
  convertManifestCode,
  findConnectionOwningInstallation,
  listInstallationRepositories,
  manifestPostUrl,
  signConnectState,
  verifyConnectState,
} from '../integrations/github/index.js';
import {
  assertVaultConfigured,
  createConnection,
  decryptConnectionSecrets,
  type IntegrationConnectionRow,
  listBindingsForProject,
  listConnectionsForPrincipalUser,
  notFound,
  resolveApiBaseUrl,
} from '../integrations/index.js';
import { SourceHostCallError } from '../integrations/source-host/index.js';
import { loadOrgRole } from '../lib/authz.js';
import { logger } from '../lib/logger.js';
import { refuser } from '../lib/refusal.js';
import { type AuthVars, assertEmailVerified, requireAuth } from '../middleware/auth.js';
import { badRequest } from '../middleware/route-errors.js';
import { zValidator } from '../middleware/zod-validator.js';
import { actorFor, projectResource, requireCan, requireOrgHeld } from '../permissions/index.js';
import { projectOrgHead } from '../projects/index.js';

const refuse = refuser<IntegrationRefusalCode>('INTEGRATION_REFUSED');

const invalidQuery = (result: { success: boolean; error?: z.core.$ZodError }) => {
  if (!result.success && result.error) throw badRequest(result.error);
};

const connectQuerySchema = z.object({ org: z.string().optional(), orgId: z.string().optional() });
const repositoriesQuerySchema = z.object({ connectionId: z.string().optional() });
const manifestCallbackQuerySchema = z.object({
  code: z.string().optional(),
  state: z.string().optional(),
});
const installedQuerySchema = z.object({
  installation_id: z.string().optional(),
  state: z.string().optional(),
});

// cm:why the admin check runs before the query is read, so a non-admin learns nothing from a 400
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
githubCallbackRoutes.use('/integrations/github/*', requireAuth(), assertEmailVerified());

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

function assertApiOriginReachable(c: Context, api: string): void {
  const url = new URL(c.req.url);
  const proto = c.req.header('x-forwarded-proto')?.split(',')[0]?.trim();
  if (proto === 'https' || proto === 'http') url.protocol = `${proto}:`;
  const forwardedHost = c.req.header('x-forwarded-host')?.split(',')[0]?.trim();
  if (forwardedHost) url.host = forwardedHost;
  if (new URL(api).origin === url.origin) return;
  throw new HTTPException(500, {
    message:
      `GitHub would be told to call back at ${new URL(api).origin}, but this request reached core at ${url.origin}. ` +
      "Set PUBLIC_API_BASE_URL to this API's public origin — APP_BASE_URL is the web frontend and cannot serve the callback.",
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
  requireOrgHeld(args.projectOrgId, await loadOrgRole(args.projectOrgId, args.userId), 'org.admin');
  return args.projectOrgId;
}

githubConnectRoutes.post(
  '/:projectId/integrations/github/connect',
  projectAdmin,
  zValidator('query', connectQuerySchema, invalidQuery),
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
    assertApiOriginReachable(c, api);

    return c.json({
      postUrl: manifestPostUrl(org),
      state: signConnectState(stateSecret(), {
        projectId,
        userId,
        ...(orgId ? { orgId } : {}),
      }),
      manifest: buildAppManifest({
        appName: `Forge — ${project.name}`,
        webBaseUrl: webBaseUrl(),
        apiBaseUrl: api,
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
  zValidator('query', repositoriesQuerySchema, invalidQuery),
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
  zValidator('query', manifestCallbackQuerySchema, invalidQuery),
  async (c) => {
    const { code, state: rawState } = c.req.valid('query');
    if (!code || !rawState) throw badRequest({ query: 'code and state are required' });

    const state = verifyConnectState(stateSecret(), rawState);
    if (!state) throw badRequest({ state: 'invalid or expired' });

    const userId = c.get('userId');
    if (state.userId !== userId) throw badRequest({ state: 'issued for another user' });

    await requireCan(actorFor(userId), 'project.admin', projectResource(state.projectId));
    assertVaultConfigured();

    const app = await convertManifestCode({ code });

    const connection = await createConnection({
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

    logger.info(
      { projectId: state.projectId, appId: app.appId, connectionId: connection.id },
      'github: app created from manifest',
    );

    const install = app.htmlUrl ? `${app.htmlUrl}/installations/new` : null;
    return c.redirect(
      install ?? `${webBaseUrl()}/projects/${state.projectId}/settings/integrations`,
    );
  },
);

githubCallbackRoutes.get(
  '/integrations/github/installed',
  zValidator('query', installedQuerySchema, invalidQuery),
  async (c) => {
    const query = c.req.valid('query');
    const installationId = Number(query.installation_id);
    const rawState = query.state;
    const userId = c.get('userId');

    const state = rawState ? verifyConnectState(stateSecret(), rawState) : null;
    if (!Number.isFinite(installationId) || installationId <= 0) {
      throw badRequest({ installation_id: 'required' });
    }
    if (rawState && !state) throw badRequest({ state: 'invalid or expired' });
    if (state && state.userId !== userId) throw badRequest({ state: 'issued for another user' });

    const owner = state ? null : await findConnectionOwningInstallation({ userId, installationId });
    if (!state && !owner) throw notFound('github app');
    const projectId = state?.projectId ?? owner?.projectId ?? null;
    if (!projectId) return c.redirect(`${webBaseUrl()}/integrations`);
    await requireCan(actorFor(userId), 'project.admin', projectResource(projectId));

    return c.redirect(`${webBaseUrl()}/projects/${projectId}/settings/integrations`);
  },
);
