import type { Context } from 'hono';
import { Hono } from 'hono';
import { z } from 'zod';
import {
  appAdvancedSettingsUrl,
  buildAppManifest,
  type ConnectState,
  clientSecretHolds,
  findAppsAwaitingCompletion,
  findInstanceGithubApp,
  INSTANCE_OWNER_ID,
  installationSettingsUrl,
  installUrl,
  instanceAppGap,
  listInstallationsForOrgs,
  MANIFEST_POST_URL,
  readAppIdentity,
  readAppVisibility,
  readInstallation,
  recordInstallation,
  signConnectState,
} from '../integrations/github/index.js';
import {
  assertVaultConfigured,
  decryptConnectionSecrets,
  effectiveConfig,
  findConnectionById,
  type IntegrationConnectionRow,
  listBindingsForConnection,
  makeConnectionInstanceOwned,
  notFound,
  notifyConnectionChanged,
  summarizeConnection,
} from '../integrations/index.js';
import { SourceHostCallError } from '../integrations/source-host/index.js';
import { projectOrgOf } from '../lib/authz.js';
import { isUniqueViolation } from '../lib/db-errors.js';
import { logger } from '../lib/logger.js';
import { providerRefused } from '../lib/provider-refusal.js';
import { type AuthVars, assertEmailVerified, requireAuth } from '../middleware/auth.js';
import { isPlatformAdmin } from '../middleware/require-admin.js';
import { badRequest } from '../middleware/route-errors.js';
import { noQuery, zValidator } from '../middleware/zod-validator.js';
import { listOrgsForUser } from '../orgs/index.js';
import { actorFor, orgResource, requireOrgCan } from '../permissions/index.js';
import { loadConnection } from './connection-routes.js';
import {
  apiBaseUrl,
  askAnOperator,
  browserReturnOrigin,
  instanceAppName,
  refuse,
  stateSecret,
  webBaseUrl,
} from './github-connect-shared.js';

const returnToSchema = z.literal('integrations').optional();
const connectBodySchema = z.strictObject({
  orgId: z.uuid(),
  returnTo: returnToSchema,
});
const completeBodySchema = z.strictObject({ clientSecret: z.string().min(8).max(500) });

export const githubAppRoutes = new Hono<{ Variables: AuthVars }>();
githubAppRoutes.use('*', requireAuth(), assertEmailVerified());

/**
 * Where Connect GitHub sends the browser for an org. With the instance's App complete, its install
 * page, carrying a state that names the org the installation will be recorded for. With none, the
 * manifest that makes it, for a platform admin only; anyone else is told whom to ask. An App the
 * instance holds without what proves an install is refused until an operator completes it, and so
 * is one a person or an org made before: an operator is sent to complete it, never to make another.
 */
export async function beginConnect(
  c: Context<{ Variables: AuthVars }>,
  args: { orgId: string; projectId?: string; returnTo?: ConnectState['returnTo'] },
): Promise<Response> {
  const userId = c.get('userId');
  assertVaultConfigured();
  // an installation recorded for an org reaches every project of it, so recording one takes its admin
  await requireOrgCan(actorFor(userId), 'org.admin', orgResource(args.orgId));
  const state = signConnectState(stateSecret(), {
    userId,
    orgId: args.orgId,
    ...(args.projectId ? { projectId: args.projectId } : {}),
    ...(args.returnTo ? { returnTo: args.returnTo } : {}),
  });

  const app = await findInstanceGithubApp();
  if (app) {
    const gap = instanceAppGap(app);
    const slug = (app.config as { appSlug?: string }).appSlug;
    if (gap || !slug) {
      throw refuse(
        'GITHUB_APP_INCOMPLETE',
        `this Forge's GitHub App lacks ${gap ?? 'its name on GitHub'}, so an installation of it cannot be proven yet. ` +
          `A Forge operator completes it with POST /api/integration-connections/${app.id}/github-app/complete. ${await askAnOperator()}`,
      );
    }
    return c.json({ kind: 'install', installUrl: installUrl(slug, state) });
  }

  const operator = await isPlatformAdmin(userId);
  // an App made before the instance had one is completed, never joined by a second
  const [earlier] = await findAppsAwaitingCompletion();
  if (earlier) {
    const completePath = `/api/integration-connections/${earlier.id}/github-app/complete`;
    if (!operator) {
      throw refuse(
        'GITHUB_APP_INCOMPLETE',
        `this Forge's GitHub App ${earlier.displayName} is not complete yet. ` +
          `A Forge operator completes it with POST ${completePath}. ${await askAnOperator()}`,
      );
    }
    return c.json({
      kind: 'complete',
      connectionId: earlier.id,
      displayName: earlier.displayName,
      completePath,
    });
  }

  if (!operator) {
    throw refuse(
      'GITHUB_APP_NOT_CONNECTED',
      `this Forge has no GitHub App yet, and only a Forge operator makes it. ${await askAnOperator()}`,
    );
  }
  const api = apiBaseUrl();
  return c.json({
    kind: 'manifest',
    postUrl: MANIFEST_POST_URL,
    state,
    manifest: buildAppManifest({
      appName: instanceAppName(),
      webBaseUrl: webBaseUrl(),
      apiBaseUrl: api,
      returnBaseUrl: browserReturnOrigin(c, api),
    }),
  });
}

githubAppRoutes.post('/github/connect', zValidator('json', connectBodySchema), async (c) => {
  const body = c.req.valid('json');
  return beginConnect(c, {
    orgId: body.orgId,
    ...(body.returnTo ? { returnTo: body.returnTo } : {}),
  });
});

/**
 * Hand an App made before this to the instance: an operator supplies the client secret GitHub shows
 * only on the App's settings page, and Forge reads the rest off GitHub with the App's own key. The
 * installations its bindings already hold are recorded for each binding's project org, so those
 * bindings keep working; nothing else is recorded until an org admin proves an install.
 */
githubAppRoutes.post(
  '/:id/github-app/complete',
  zValidator('json', completeBodySchema),
  async (c) => {
    const userId = c.get('userId');
    if (!(await isPlatformAdmin(userId))) {
      throw refuse(
        'GITHUB_APP_OPERATOR_ONLY',
        `only a Forge operator completes this Forge's GitHub App. ${await askAnOperator()}`,
      );
    }
    assertVaultConfigured();
    const connection = await findConnectionById(c.req.param('id'));
    if (!connection) throw notFound('connection');
    if (connection.provider !== 'github' || !connection.active) {
      throw refuse(
        'GITHUB_APP_NOT_INSTANCE',
        `connection ${connection.id} is ${connection.active ? `a ${connection.provider} connection` : 'switched off'}, and only a live GitHub App connection becomes this Forge's App.`,
      );
    }
    const held = await findInstanceGithubApp();
    if (held && held.id !== connection.id) {
      throw refuse(
        'GITHUB_APP_NOT_INSTANCE',
        `this Forge's GitHub App is already connection ${held.id}; one App serves the instance.`,
      );
    }
    const secrets = decryptConnectionSecrets<Record<string, unknown>>(connection);
    const appId = typeof secrets.appId === 'string' ? secrets.appId : null;
    const privateKey = typeof secrets.privateKey === 'string' ? secrets.privateKey : null;
    if (!appId || !privateKey) throw badRequest({ id: 'the App was never converted' });

    const { clientSecret } = c.req.valid('json');
    let identity: Awaited<ReturnType<typeof readAppIdentity>>;
    try {
      identity = await readAppIdentity({ appId, privateKey });
    } catch (err) {
      throw providerRefused(
        `${err instanceof Error ? err.message : String(err)}, so the App cannot be completed`,
        'GITHUB_REFUSED',
        { retryAt: err instanceof SourceHostCallError ? err.retryAt : null },
      );
    }
    const check = await clientSecretHolds({ clientId: identity.clientId, clientSecret });
    if (!check.holds) throw badRequest({ clientSecret: check.reason });

    const recorded: Array<{ installationId: number; orgId: string; state: string }> = [];
    const notRecorded: Array<{ installationId: number; projectId: string; reason: string }> = [];
    for (const pair of await listBindingsForConnection(connection.id)) {
      const installationId = (pair.binding.config as { installationId?: unknown }).installationId;
      if (typeof installationId !== 'number') continue;
      const orgId = await projectOrgOf(pair.binding.projectId);
      if (!orgId) continue;
      const first = recorded.find((r) => r.installationId === installationId);
      if (first) {
        if (first.orgId !== orgId) {
          notRecorded.push({
            installationId,
            projectId: pair.binding.projectId,
            reason: `recorded for org ${first.orgId}; this binding keeps working on what it holds`,
          });
        }
        continue;
      }
      const account = await readInstallation({ appId, privateKey, installationId });
      const outcome = await recordInstallation({
        connectionId: connection.id,
        installationId,
        accountLogin: account?.login || (pair.binding.config as { owner?: string }).owner || '',
        accountType: account?.type ?? 'User',
        orgId,
        recordedBy: userId,
        proof: 'bound_before',
        ...(account ? {} : { state: 'gone' as const, stateChangedAt: new Date() }),
      });
      if (!outcome.ok) {
        notRecorded.push({
          installationId,
          projectId: pair.binding.projectId,
          reason: `recorded for org ${outcome.claimedBy}; this binding keeps working on what it holds`,
        });
        continue;
      }
      recorded.push({ installationId, orgId, state: account ? 'active' : 'gone' });
    }

    let updated: IntegrationConnectionRow | null;
    try {
      updated = await makeConnectionInstanceOwned(connection.id, {
        config: {
          ...((connection.config ?? {}) as Record<string, unknown>),
          appSlug: identity.slug,
          appOwner: identity.owner.login,
          appOwnerIsOrg: identity.owner.isOrg,
        },
        secrets: { ...secrets, clientId: identity.clientId, clientSecret },
      });
    } catch (err) {
      if (!isUniqueViolation(err)) throw err;
      throw refuse('GITHUB_APP_NOT_INSTANCE', "another GitHub App became this Forge's first.");
    }
    if (!updated) throw notFound('connection');
    logger.info(
      { connectionId: connection.id, ownerId: INSTANCE_OWNER_ID, recorded: recorded.length },
      'github: an App was handed to the instance',
    );
    notifyConnectionChanged('github', connection.id);
    return c.json({ connection: summarizeConnection(updated), recorded, notRecorded });
  },
);

/**
 * A GitHub App connection as its directory row reads it: whether GitHub lets any account install
 * it, the installations recorded for the caller's orgs with whether any project uses each, and what
 * an operator still has to do before it serves the instance.
 */
githubAppRoutes.get('/:id/github-app', noQuery, async (c) => {
  const userId = c.get('userId');
  const connection = await loadConnection(c.req.param('id'), userId, 'read');
  if (connection.provider !== 'github') {
    throw refuse(
      'GITHUB_APP_NOT_INSTANCE',
      `connection ${connection.id} is a ${connection.provider} connection, not a GitHub App.`,
    );
  }
  const config = (connection.config ?? {}) as {
    appSlug?: string;
    appOwner?: string;
    appOwnerIsOrg?: boolean;
  };
  const instance = connection.ownerType === 'instance';
  // an App not yet the instance's, or one lacking what proves an install, waits on an operator
  const awaitsCompletion = !instance || instanceAppGap(connection) !== null;
  const slug = config.appSlug ?? null;
  const visibility = slug ? await readAppVisibility(slug) : 'unknown';

  const orgIds = (await listOrgsForUser(userId)).map((o) => o.id);
  const recorded = instance ? await listInstallationsForOrgs(connection.id, orgIds) : [];
  const used = new Set(
    (await listBindingsForConnection(connection.id))
      .filter((pair) => pair.binding.active)
      .map((pair) => effectiveConfig<{ installationId?: number }>(pair).installationId),
  );

  return c.json({
    connectionId: connection.id,
    instance,
    slug,
    owner: config.appOwner ?? null,
    visibility,
    makePublicUrl:
      visibility === 'private' && slug && config.appOwner
        ? appAdvancedSettingsUrl(slug, config.appOwner, config.appOwnerIsOrg === true)
        : null,
    completePath: awaitsCompletion
      ? `/api/integration-connections/${connection.id}/github-app/complete`
      : null,
    installations: recorded.map((row) => ({
      installationId: row.installationId,
      account: row.accountLogin,
      accountType: row.accountType,
      state: row.state,
      used: used.has(row.installationId),
      settingsUrl: installationSettingsUrl(
        row.installationId,
        row.accountLogin,
        row.accountType !== 'User',
      ),
    })),
  });
});
