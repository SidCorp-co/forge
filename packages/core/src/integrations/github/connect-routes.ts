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
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { db } from '../../db/client.js';
import { projects } from '../../db/schema.js';
import { logger } from '../../logger.js';
import { type AuthVars, assertEmailVerified, requireAuth } from '../../middleware/auth.js';
import {
  assertAdmin,
  assertProjectMember,
  assertVaultConfigured,
  badRequest,
  notFound,
} from '../route-helpers.js';
import { createBinding, createConnection, listActiveBindingsForProjectProvider } from '../store.js';
import {
  buildAppManifest,
  convertManifestCode,
  manifestPostUrl,
  signConnectState,
  verifyConnectState,
} from './connect.js';

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

function appBaseUrl(): string {
  const base = process.env.APP_BASE_URL;
  if (!base) throw new HTTPException(500, { message: 'APP_BASE_URL is not configured' });
  return base;
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

  return c.json({
    postUrl: manifestPostUrl(org),
    state: signConnectState(stateSecret(), { projectId, userId, environment }),
    manifest: buildAppManifest({
      appName: `Forge — ${project.name}`,
      appBaseUrl: appBaseUrl(),
      projectSlug: project.slug,
    }),
  });
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

  const connection = await createConnection({
    ownerId: userId,
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
  return c.redirect(install ?? `${appBaseUrl()}/projects/${state.projectId}/settings/integrations`);
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
  if (!state) {
    throw badRequest({ state: 'missing — install the App from the link Forge gave you' });
  }
  if (state.userId !== userId) throw badRequest({ state: 'issued for another user' });

  assertAdmin(await assertProjectMember(state.projectId, userId));

  const pairs = await listActiveBindingsForProjectProvider(state.projectId, 'github');
  const pair = pairs[0];
  if (!pair) throw notFound('github binding');

  const { updateBinding } = await import('../store.js');
  await updateBinding(pair.binding.id, {
    config: { ...(pair.binding.config as Record<string, unknown>), installationId },
  });

  return c.redirect(`${appBaseUrl()}/projects/${state.projectId}/settings/integrations`);
});
