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
import { env } from '../../config/env.js';
import { db } from '../../db/client.js';
import { projects } from '../../db/schema.js';
import { loadOrgRole, orgRoleAtLeast } from '../../lib/authz.js';
import { logger } from '../../logger.js';
import { type AuthVars, assertEmailVerified, requireAuth } from '../../middleware/auth.js';
import {
  assertAdmin,
  assertProjectMember,
  assertVaultConfigured,
  badRequest,
  forbidden,
  notFound,
} from '../route-helpers.js';
import {
  createBinding,
  createConnection,
  decryptConnectionSecrets,
  listActiveBindingsForProjectProvider,
  listConnectionsForPrincipalUser,
} from '../store.js';
import {
  buildAppManifest,
  convertManifestCode,
  manifestPostUrl,
  signConnectState,
  verifyConnectState,
} from './connect.js';
import { findBindingOwningInstallation } from './install-resolve.js';
import { listInstallationRepositories } from './repositories.js';

// cm:guard these are TWO apps because they mount at different prefixes: the project-scoped one under `/api/projects`, the callbacks under `/api`. Folding the callbacks into the first would put them at `/api/projects/integrations/...`, where `integrations` is read as a `:projectId` by every sibling route.
export const githubConnectRoutes = new Hono<{ Variables: AuthVars }>();
githubConnectRoutes.use('*', requireAuth(), assertEmailVerified());

// cm:guard scope this guard to its OWN path, never `'*'` — mounted at the broad `/api` prefix, a `use('*')` becomes `/api/*` on the parent and runs for every route registered after it, including the deliberately unauthenticated `/api/webhooks/in/:slug`. Measured 2026-09-06: with `'*'` here, every GitHub webhook delivery answered 401 UNAUTHENTICATED while the integration still displayed as configured.
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

// cm:guard resolve this from CONFIG, never from the request's Host header — `redirect_url` is where GitHub delivers the conversion code that yields the App's PRIVATE KEY, so a forged Host would hand it to the forger. The request's own origin is read below only to REFUSE on a mismatch, which a forged header can at worst turn into a denial.
function apiBaseUrl(): string {
  const base = env.PUBLIC_API_BASE_URL ?? env.OAUTH_REDIRECT_BASE ?? process.env.APP_BASE_URL;
  if (!base) throw new HTTPException(500, { message: 'APP_BASE_URL is not configured' });
  return base.replace(/\/+$/, '');
}

// cm:guard a manifest whose callback names an origin this core is not reachable on strands the operator AFTER GitHub has created the App — the state is spent, the App exists, and only a hand-edit recovers it. So refuse while nothing has been created, naming both origins. Measured 2026-09-06: APP_BASE_URL was the web host, and all three core URLs 404'd.
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

githubConnectRoutes.post('/:projectId/integrations/github/connect', async (c) => {
  const projectId = c.req.param('projectId');
  const userId = c.get('userId');
  assertAdmin(await assertProjectMember(projectId, userId));
  assertVaultConfigured();

  const [project] = await db
    .select({ slug: projects.slug, name: projects.name })
    .from(projects)
    .where(eq(projects.id, projectId))
    .limit(1);
  if (!project) throw notFound('project');

  const url = new URL(c.req.url);
  const org = url.searchParams.get('org');
  const environment = url.searchParams.get('environment') ?? 'prod';
  const orgId = url.searchParams.get('orgId') ?? undefined;

  // cm:edge contract -> packages/core/src/integrations/connection-routes.ts — the same org-admin gate the generic connection create applies; an App shared by every project in an org may not be created by a member who could not create the connection directly.
  if (orgId) {
    const orgRole = await loadOrgRole(orgId, userId);
    if (!orgRole) throw notFound('org');
    if (!orgRoleAtLeast(orgRole, 'admin')) throw forbidden();
  }

  const api = apiBaseUrl();
  assertApiOriginReachable(c, api);

  return c.json({
    postUrl: manifestPostUrl(org),
    state: signConnectState(stateSecret(), {
      projectId,
      userId,
      environment,
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

// cm:guard list from the INSTALLATIONS, never from an account's repositories — an App reaches only what its operator granted it, so an account-wide list would offer repositories the binding then fails on, and the failure would arrive at the first webhook rather than at the picker.
githubConnectRoutes.get('/:projectId/integrations/github/repositories', async (c) => {
  const projectId = c.req.param('projectId');
  const userId = c.get('userId');
  assertAdmin(await assertProjectMember(projectId, userId));

  const connectionId = c.req.query('connectionId');
  if (!connectionId) throw badRequest({ connectionId: 'required' });

  const connection = (await listConnectionsForPrincipalUser(userId)).find(
    (x) => x.id === connectionId && x.provider === 'github',
  );
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

  // cm:guard the session must be the user the state was signed for — the state proves Forge issued it, NOT that this browser is the one that asked. Skipping this lets a signed state be replayed in somebody else's session, binding an attacker's App to their project.
  const userId = c.get('userId');
  if (state.userId !== userId) throw badRequest({ state: 'issued for another user' });

  assertAdmin(await assertProjectMember(state.projectId, userId));
  assertVaultConfigured();

  const app = await convertManifestCode({ code });

  // cm:guard one App serves EVERY project bound to it — `owner`/`repo` are binding-tier keys (integrations/provider-schemas.ts), so the repository a project uses lives on its binding and never on the App. Minting an App per project puts the scope in the wrong place and costs a private key, a webhook secret and an approval screen each time.
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

  // cm:guard the binding's `integrationSecret` is the APP's webhook secret, never a freshly minted one — GitHub signs with what it generated, so a minted secret would fail every signature check while the UI showed the integration as configured.
  await createBinding({
    connectionId: connection.id,
    projectId: state.projectId,
    provider: 'github',
    environment: state.environment === 'staging' ? 'staging' : 'prod',
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

  // cm:guard GitHub omits `state` when the operator installs the App from its own page rather than from the link Forge handed them, so this must resolve the binding from the App itself. Refusing without state would strand the flow at its last step with the App already created.
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
