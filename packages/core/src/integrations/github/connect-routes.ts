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
import { answer } from '../../api-reference/declare/describe.js';
import { db } from '../../db/client.js';
import { organizations, projects } from '../../db/schema.js';
import { effectiveProjectRole, loadOrgRole, orgRoleAtLeast } from '../../lib/authz.js';
import { logger } from '../../logger.js';
import { type AuthVars, assertEmailVerified, requireAuth } from '../../middleware/auth.js';
import { recordInstallation } from '../binding-installation.js';
import { isRemovedConnection, turnsBackOnFrom } from '../held-key.js';
import { findReachableConnection } from '../reach.js';
import {
  assertAdmin,
  assertProjectMember,
  assertVaultConfigured,
  badRequest,
  connectionNotReachable,
  notFound,
} from '../route-helpers.js';
import {
  type BindingWithConnection,
  createBinding,
  createConnection,
  decryptConnectionSecrets,
  type IntegrationConnectionRow,
  listActiveBindingsForProjectProvider,
  listBindingsForConnection,
  listBindingsForProject,
  removedConnectionBoundTo,
  updateBinding,
  updateConnection,
} from '../store.js';
import {
  buildAppManifest,
  convertManifestCode,
  manifestPostUrl,
  resolveApiBaseUrl,
  signConnectState,
  verifyConnectState,
} from './connect.js';
import {
  declaresConnectQuery,
  declaresInstalledQuery,
  declaresManifestCallbackQuery,
  declaresRepositoriesQuery,
  githubInstalled,
  githubManifestCallback,
  installedQuerySchema,
  listGithubRepositories,
  manifestCallbackQuerySchema,
  manifestSchema,
  repositoriesSchema,
  startGithubConnect,
} from './connect-routes-reference.js';
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
 * an org project's App belongs to that org rather than to whoever pressed
 * Connect (ISS-1115). The refusal is taken HERE and not in the callback,
 * where a real App already exists on github.com and refusing would strand it.
 */
async function ownerOrgForProjectApp(args: {
  projectOrgId: string | null;
  orgName: string;
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
    // Its own code, not a bare FORBIDDEN: the web prints one generic sentence
    // for that and drops the server's, which carries the way round.
    // Named by its name and asked of a person by what they press (ISS-1421 r23): the id, "you are
    // member", a Connect no control is called and a binding this panel does not offer were not.
    throw new HTTPException(403, {
      message:
        `This project belongs to the organization ${args.orgName}, so a GitHub App created here ` +
        `belongs to it. Only an owner or admin of ${args.orgName} can create one, and you are ` +
        `${orgRole === null ? 'not a member of it' : `a ${orgRole} there`}. Ask one of them to ` +
        "create it from this project's Integrations tab.",
      cause: { code: 'ORG_ADMIN_REQUIRED', details: { orgId: args.projectOrgId } },
    });
  }
  return args.projectOrgId;
}

githubConnectRoutes.post(
  '/:projectId/integrations/github/connect',
  ...startGithubConnect,
  declaresConnectQuery,
  async (c) => {
    const projectId = c.req.param('projectId');
    const userId = c.get('userId');
    assertAdmin(await assertProjectMember(projectId, userId));
    assertVaultConfigured();

    const [project] = await db
      .select({
        slug: projects.slug,
        name: projects.name,
        orgId: projects.orgId,
        orgName: organizations.name,
        orgIsPersonal: organizations.isPersonal,
      })
      .from(projects)
      .innerJoin(organizations, eq(organizations.id, projects.orgId))
      .where(eq(projects.id, projectId))
      .limit(1);
    if (!project) throw notFound('project');

    const { org, orgId: asked } = c.req.valid('query');
    const orgId = await ownerOrgForProjectApp({
      // A solo operator's org row is their PERSONAL one, and the connections
      // directory scopes such an org to `ownerType:'user'` — an App owned by it
      // would be invisible to its only admin. So: no shared owner.
      projectOrgId: project.orgIsPersonal ? null : project.orgId,
      orgName: project.orgName,
      asked: asked ?? null,
      userId,
    });
    await assertRemovedConnectionTakesTheApp(
      projectId,
      orgId ? { ownerType: 'org', ownerId: orgId } : { ownerType: 'user', ownerId: userId },
    );

    const api = apiBaseUrl();
    assertApiOriginReachable(c, api);

    return c.json(
      answer(manifestSchema, {
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
      }),
    );
  },
);

/**
 * The removed GitHub connection this project's binding names, when the App about to be created would
 * not belong to its owner: the callback could not turn that connection back on, and its binding holds
 * the project's one GitHub slot, so the App would be left on GitHub with nowhere to go. Refused here,
 * before anything is created (ISS-1421 r22).
 */
async function assertRemovedConnectionTakesTheApp(
  projectId: string,
  owner: { ownerType: 'user' | 'org'; ownerId: string },
): Promise<void> {
  const removed = (await listBindingsForProject(projectId)).find(
    (p) =>
      p.binding.provider === 'github' &&
      p.binding.role === 'service' &&
      isRemovedConnection(p.connection),
  );
  if (!removed) return;
  const { ownerType, ownerId } = removed.connection;
  if (ownerType === owner.ownerType && ownerId === owner.ownerId) return;
  throw new HTTPException(409, {
    message:
      "This project's GitHub binding names a removed connection that an App created here would not " +
      'belong to, so the new App could not take its place. Disconnect it from this project, then ' +
      'create the App.',
    cause: {
      code: 'REMOVED_CONNECTION_OTHER_OWNER',
      details: { connectionId: removed.connection.id },
    },
  });
}

/**
 * A GitHub connection whose App was never finished: the manifest round trip that stores the App's
 * key never came back. Its own code, since the web words `BAD_REQUEST` as a generic "Invalid input"
 * and this sentence is the one that says what is missing and what to press (ISS-1421 r8).
 */
const githubAppUnfinished = (connectionId: string) =>
  new HTTPException(409, {
    message:
      'This GitHub connection has no App yet: creating it on GitHub was never finished. ' +
      'Use Create a separate App instead.',
    cause: { code: 'GITHUB_APP_UNFINISHED', details: { connectionId } },
  });

/**
 * A removed GitHub connection's repositories asked for: it holds no App until one is installed again,
 * from a project bound to it, which is this one only where it is (ISS-1421 r23).
 */
async function githubConnectionRemoved(connectionId: string, projectId: string) {
  const bound = (await listBindingsForConnection(connectionId)).map((p) => p.binding.projectId);
  return new HTTPException(409, {
    message: `This GitHub connection was removed, so it holds no App. ${turnsBackOnFrom('github', bound, projectId)}`,
    cause: { code: 'CONNECTION_REMOVED', details: { connectionId } },
  });
}

/**
 * The App whose repositories this project's picker may list: one the caller reaches by the rule
 * every door reads (`../reach.ts`), asked after the route has proved the caller an admin of the
 * project. A connection this project's binding points at is reached whoever owns it and whether or
 * not it is switched off, since a repick starts from a disconnected row; one the caller owns is
 * reached before any binding to this project exists, which is where the create path lists.
 *
 * This was a second private copy of the reach question, found refusing once ISS-1115 widened it
 * and the directory and the connection's own routes had not been.
 */
async function githubConnectionForPicker(args: {
  userId: string;
  connectionId: string;
}): Promise<IntegrationConnectionRow> {
  const reached = await findReachableConnection(args.userId, args.connectionId);
  if (!reached) throw connectionNotReachable(args.connectionId);
  if (reached.connection.provider !== 'github') {
    throw badRequest({ connectionId: 'is not a GitHub App, so it has no repositories to list' });
  }
  return reached.connection;
}

githubConnectRoutes.get(
  '/:projectId/integrations/github/repositories',
  ...listGithubRepositories,
  declaresRepositoriesQuery,
  async (c) => {
    const projectId = c.req.param('projectId');
    const userId = c.get('userId');
    assertAdmin(await assertProjectMember(projectId, userId));

    const { connectionId } = c.req.valid('query');

    const connection = await githubConnectionForPicker({ userId, connectionId });
    // Removed is not unfinished: the App was there, and a remove took it (ISS-1421 r22).
    if (isRemovedConnection(connection))
      throw await githubConnectionRemoved(connectionId, projectId);

    const { appId, privateKey } = decryptConnectionSecrets<{
      appId?: string;
      privateKey?: string;
    }>(connection);
    if (!appId || !privateKey) throw githubAppUnfinished(connectionId);

    return c.json(
      answer(repositoriesSchema, await listInstallationRepositories({ appId, privateKey })),
    );
  },
);

githubCallbackRoutes.get(
  '/integrations/github/manifest-callback',
  githubManifestCallback,
  declaresManifestCallbackQuery,
  async (c) => {
    const { code, state: rawState } = manifestCallbackQuerySchema.parse(c.req.query());
    // Each parameter GitHub's redirect left out is named (ISS-1421 r20: "The field query was refused.").
    if (!code || !rawState)
      throw badRequest({
        ...(code ? {} : { code: 'required' }),
        ...(rawState ? {} : { state: 'required' }),
      });

    const state = verifyConnectState(stateSecret(), rawState);
    if (!state) throw badRequest({ state: 'invalid or expired' });

    const userId = c.get('userId');
    if (state.userId !== userId) throw badRequest({ state: 'issued for another user' });

    assertAdmin(await assertProjectMember(state.projectId, userId));
    assertVaultConfigured();

    const app = await convertManifestCode({ code });
    const owner = state.orgId
      ? ({ ownerType: 'org', ownerId: state.orgId } as const)
      : ({ ownerType: 'user', ownerId: userId } as const);
    const displayName = app.slug ? `GitHub App ${app.slug}` : 'GitHub App';
    const secrets = {
      appId: app.appId,
      privateKey: app.privateKey,
      webhookSecret: app.webhookSecret,
    };

    // ISS-1421 r21: the removed connection this project is still bound to takes the new App and turns
    // back on, rather than a second connection standing beside one nothing could turn on.
    const removed = await removedConnectionBoundTo(state.projectId, 'github', owner);
    const connection = removed
      ? await reattach(removed, { displayName, secrets, webhookSecret: app.webhookSecret })
      : await createConnection({ ...owner, provider: 'github', displayName, config: {}, secrets });

    if (!removed) {
      await createBinding({
        connectionId: connection.id,
        projectId: state.projectId,
        provider: 'github',
        role: 'service',
        config: {},
        integrationSecret: app.webhookSecret,
      });
    }

    logger.info(
      { projectId: state.projectId, appId: app.appId, connectionId: connection.id },
      'github: app created from manifest',
    );

    // GitHub hands `state` on to the setup URL, so the install is recorded on this project's
    // binding: a reattached connection holds others, and the state-less read takes the first.
    const install = app.htmlUrl
      ? `${app.htmlUrl}/installations/new?state=${encodeURIComponent(signConnectState(stateSecret(), state))}`
      : null;
    return c.redirect(
      install ?? `${webBaseUrl()}/projects/${state.projectId}/settings/integrations`,
    );
  },
);

/** A removed connection given a new App: its keys, its name, switched on, its old check gone. */
async function reattach(
  removed: BindingWithConnection,
  next: { displayName: string; secrets: Record<string, string>; webhookSecret: string },
): Promise<{ id: string }> {
  const updated = await updateConnection(removed.connection.id, {
    displayName: next.displayName,
    secrets: next.secrets,
    active: true,
    lastHealthStatus: null,
    lastHealthDetail: null,
    lastHealthAt: null,
  });
  // Every binding of the connection takes the new App's webhook secret and loses the old App's
  // installation, which is not the new App's: the install step records the new one on each of them.
  // Each keeps its own switch but the one this install was run from, which is turned on.
  for (const { binding } of await listBindingsForConnection(removed.connection.id)) {
    const { installationId: _old, ...config } = binding.config as Record<string, unknown>;
    await updateBinding(binding.id, {
      config,
      integrationSecret: next.webhookSecret,
      ...(binding.id === removed.binding.id ? { active: true } : {}),
    });
  }
  return { id: updated?.id ?? removed.connection.id };
}

const administers = async (userId: string, projectId: string) =>
  (await effectiveProjectRole(userId, projectId))?.role === 'admin';

githubCallbackRoutes.get(
  '/integrations/github/installed',
  githubInstalled,
  declaresInstalledQuery,
  async (c) => {
    const { installation_id: rawInstallation, state: rawState } = installedQuerySchema.parse(
      c.req.query(),
    );
    const installationId = Number(rawInstallation);
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

    await recordInstallation(pair.binding.id, installationId, false);
    // One installation belongs to its connection (the master's ruling, ISS-1421 r22): every other
    // project bound to it that holds none, as a reattach leaves them, takes it. One already held is
    // never replaced, since an App installed on two GitHub accounts has two. The authority boundary
    // wins (ruling, r22 repair): a caller who reaches the App only by a binding writes only onto
    // the projects it administers.
    const holdsApp = (await findReachableConnection(userId, pair.binding.connectionId))?.canManage;
    for (const other of await listBindingsForConnection(pair.binding.connectionId)) {
      if (other.binding.id === pair.binding.id || other.binding.provider !== 'github') continue;
      if (!holdsApp && !(await administers(userId, other.binding.projectId))) continue;
      await recordInstallation(other.binding.id, installationId, true);
    }

    return c.redirect(`${webBaseUrl()}/projects/${projectId}/settings/integrations`);
  },
);
