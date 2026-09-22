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

import { eq } from 'drizzle-orm';
import type { Context } from 'hono';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { db } from '../../db/client.js';
import { organizations, projects } from '../../db/schema.js';
import { loadOrgRole, orgRoleAtLeast } from '../../lib/authz.js';
import { logger } from '../../logger.js';
import { type AuthVars, assertEmailVerified, requireAuth } from '../../middleware/auth.js';
import {
  assertAdmin,
  assertProjectMember,
  assertVaultConfigured,
  badRequest,
  notFound,
} from '../route-helpers.js';
import {
  createBinding,
  createConnection,
  decryptConnectionSecrets,
  type IntegrationConnectionRow,
  listActiveBindingsForProjectProvider,
  listBindingsForProject,
  listConnectionsForPrincipalUser,
} from '../store.js';
import {
  buildAppManifest,
  convertManifestCode,
  manifestPostUrl,
  resolveApiBaseUrl,
  signConnectState,
  verifyConnectState,
} from './connect.js';
import { findBindingOwningInstallation } from './install-resolve.js';
import { listInstallationRepositories } from './repositories.js';

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
 * an org project's App belongs to that org. Keyed instead to the individual
 * who pressed Connect it is resolvable by nobody else, and every other admin
 * of the same project — the org's own owner included — is answered
 * `connection not found` (ISS-1115). A project whose only org is a personal
 * one has no second principal to name and stays the operator's.
 *
 * The refusal is taken HERE rather than in the callback because by callback
 * time a real App exists on github.com: refusing then would strand it.
 */
async function ownerOrgForProjectApp(args: {
  projectOrgId: string | null;
  asked: string | null;
  userId: string;
}): Promise<string | undefined> {
  if (args.asked && args.asked !== args.projectOrgId) {
    throw new HTTPException(409, {
      message:
        "org connection must belong to the project's own org — this project belongs to " +
        `${args.projectOrgId ?? 'no shared org'}, and the request named ${args.asked}.`,
      cause: { code: 'ORG_MISMATCH' },
    });
  }
  if (!args.projectOrgId) return undefined;
  const orgRole = await loadOrgRole(args.projectOrgId, args.userId);
  if (!orgRoleAtLeast(orgRole, 'admin')) {
    // Its own code rather than a bare FORBIDDEN: the web maps FORBIDDEN to one
    // generic sentence and drops the server's, and a refusal that cannot say
    // org admin, which org, or that binding an existing App is the way round
    // sends the operator back round the loop this issue exists to end.
    throw new HTTPException(403, {
      message:
        `this project belongs to org ${args.projectOrgId}, so a GitHub App created here is ` +
        'owned by that org and reachable by every admin of the project. Creating one requires ' +
        `org admin there; you are ${orgRole ?? 'not a member of that org'}. Ask an org admin to ` +
        'run Connect, or bind an existing GitHub App to this project instead.',
      cause: { code: 'ORG_ADMIN_REQUIRED' },
    });
  }
  return args.projectOrgId;
}

githubConnectRoutes.post('/:projectId/integrations/github/connect', async (c) => {
  const projectId = c.req.param('projectId');
  const userId = c.get('userId');
  assertAdmin(await assertProjectMember(projectId, userId));
  assertVaultConfigured();

  const [project] = await db
    .select({
      slug: projects.slug,
      name: projects.name,
      orgId: projects.orgId,
      orgIsPersonal: organizations.isPersonal,
    })
    .from(projects)
    .innerJoin(organizations, eq(organizations.id, projects.orgId))
    .where(eq(projects.id, projectId))
    .limit(1);
  if (!project) throw notFound('project');

  const url = new URL(c.req.url);
  const org = url.searchParams.get('org');
  const orgId = await ownerOrgForProjectApp({
    // Every project has an org row, and a solo operator's is their PERSONAL
    // one. That is not a second principal: the connections directory scopes a
    // personal org to `ownerType:'user'`, so an App owned by it would be
    // invisible to the only person who has one. Personal org ⇒ no shared owner.
    projectOrgId: project.orgIsPersonal ? null : project.orgId,
    asked: url.searchParams.get('orgId'),
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
});

/**
 * The App whose repositories this project's picker may list.
 *
 * Two grants, and the route has already proved the caller is an admin of the
 * project before either is read:
 *
 *  - the project's own binding points at it. Ownership of the connection is
 *    not asked, because binding it here was itself an act of somebody who
 *    could manage it plus an admin of this project, and listing the App's
 *    repositories is exactly what the binding is for. Asking the caller's
 *    personal principal INSTEAD is what answered every admin but the one who
 *    pressed Connect with `connection not found` (ISS-1115 criterion 7). The
 *    binding is read whether or not it is switched off: a repick starts from
 *    a disconnected row.
 *  - the caller can see it as a principal. This is the create path, which
 *    lists an App's repositories BEFORE any binding to this project exists.
 *
 * Neither is a fallback for the other: they are two different grants, and a
 * connection under neither is refused rather than reached by a third route.
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

githubConnectRoutes.get('/:projectId/integrations/github/repositories', async (c) => {
  const projectId = c.req.param('projectId');
  const userId = c.get('userId');
  assertAdmin(await assertProjectMember(projectId, userId));

  const connectionId = c.req.query('connectionId');
  if (!connectionId) throw badRequest({ connectionId: 'required' });

  const connection = await githubConnectionForPicker({ projectId, userId, connectionId });
  if (!connection) throw notFound('connection');

  const { appId, privateKey } = decryptConnectionSecrets<{
    appId?: string;
    privateKey?: string;
  }>(connection);
  if (!appId || !privateKey) throw badRequest({ connectionId: 'the App was never converted' });

  return c.json(await listInstallationRepositories({ appId, privateKey }));
});

githubCallbackRoutes.get('/integrations/github/manifest-callback', async (c) => {
  const code = c.req.query('code');
  const rawState = c.req.query('state');
  if (!code || !rawState) throw badRequest({ query: 'code and state are required' });

  const state = verifyConnectState(stateSecret(), rawState);
  if (!state) throw badRequest({ state: 'invalid or expired' });

  const userId = c.get('userId');
  if (state.userId !== userId) throw badRequest({ state: 'issued for another user' });

  assertAdmin(await assertProjectMember(state.projectId, userId));
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

  await createBinding({
    connectionId: connection.id,
    projectId: state.projectId,
    provider: 'github',
    role: 'service',
    config: {},
    integrationSecret: app.webhookSecret,
  });

  logger.info(
    { projectId: state.projectId, appId: app.appId, connectionId: connection.id },
    'github: app created from manifest',
  );

  const install = app.htmlUrl ? `${app.htmlUrl}/installations/new` : null;
  return c.redirect(install ?? `${webBaseUrl()}/projects/${state.projectId}/settings/integrations`);
});

githubCallbackRoutes.get('/integrations/github/installed', async (c) => {
  const installationId = Number(c.req.query('installation_id'));
  const rawState = c.req.query('state');
  const userId = c.get('userId');

  const state = rawState ? verifyConnectState(stateSecret(), rawState) : null;
  if (!Number.isFinite(installationId) || installationId <= 0) {
    throw badRequest({ installation_id: 'required' });
  }
  if (rawState && !state) throw badRequest({ state: 'invalid or expired' });
  if (state && state.userId !== userId) throw badRequest({ state: 'issued for another user' });

  const pair = state
    ? (await listActiveBindingsForProjectProvider(state.projectId, 'github'))[0]
    : await findBindingOwningInstallation({ userId, installationId });
  if (!pair) throw notFound('github binding');

  const projectId = state?.projectId ?? pair.binding.projectId;
  assertAdmin(await assertProjectMember(projectId, userId));

  const { updateBinding } = await import('../store.js');
  await updateBinding(pair.binding.id, {
    config: { ...(pair.binding.config as Record<string, unknown>), installationId },
  });

  return c.redirect(`${webBaseUrl()}/projects/${projectId}/settings/integrations`);
});
