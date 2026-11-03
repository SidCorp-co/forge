/**
 * Routes for connecting GitHub through the one App this Forge instance owns, begun on a project or
 * returning from GitHub. The instance App's own routes are `github-app-routes.ts`.
 *
 *   POST /projects/:projectId/integrations/github/connect  → Connect GitHub, for the project's org
 *   GET  /projects/:projectId/integrations/github/repositories → what its picker may list
 *   GET  /integrations/github/manifest-callback            → GitHub returns the code here
 *   GET  /integrations/github/installed                    → GitHub returns the installation here
 *
 * The two GETs are browser redirects from GitHub, so they carry the person's own session cookie and
 * admit whom requireAuth admits. Everything they cannot finish lands on the web Integrations page
 * naming why (`?connect=<cause>`), never as JSON on the API's origin: by the first callback GitHub
 * has already made the App, and a refusal nobody reads leaves it stranded there (FB-128).
 */

import type { Context } from 'hono';
import { Hono } from 'hono';
import { z } from 'zod';
import {
  type ConnectState,
  type ConnectStateRead,
  type ConvertedApp,
  convertManifestCode,
  findAppsAwaitingCompletion,
  findConnectionOwningInstallation,
  findInstanceGithubApp,
  INSTANCE_OWNER_ID,
  installUrl,
  listInstallationRepositories,
  proveInstallation,
  readConnectState,
  recordInstallation,
  signConnectState,
} from '../integrations/github/index.js';
import {
  createConnection,
  decryptConnectionSecrets,
  type IntegrationConnectionRow,
  isVaultConfigured,
  listBindingsForProject,
  listConnectionsForPrincipalUser,
  notFound,
} from '../integrations/index.js';
import { SourceHostCallError } from '../integrations/source-host/index.js';
import { isUniqueViolation } from '../lib/db-errors.js';
import { logger } from '../lib/logger.js';
import { providerRefused } from '../lib/provider-refusal.js';
import {
  type AuthVars,
  assertEmailVerified,
  requireAuth,
  requireAuthOrLand,
} from '../middleware/auth.js';
import { gatedRoutes } from '../middleware/gated-routes.js';
import { badRequest } from '../middleware/route-errors.js';
import { zValidator } from '../middleware/zod-validator.js';
import { requiresByRule, requiresOnParam } from '../permissions/index.js';
import { projectOrgHead } from '../projects/index.js';
import { beginConnect } from './github-app-routes.js';
import {
  installCallbackStrand,
  manifestCallbackStrand,
  strandMayNameApp,
} from './github-callback-rules.js';
import { finishedAt, nameStrandedApp, stateSecret, strandedAt } from './github-connect-shared.js';
import { instanceInstallationsFor, projectsAdministeredBy } from './github-reach.js';

const returnToSchema = z.literal('integrations').optional();
const projectConnectQuerySchema = z.strictObject({ returnTo: returnToSchema });
const repositoriesQuerySchema = z.object({ connectionId: z.string().optional() });
// GitHub redirects to both and adds keys of its own (setup_action on an install)
const manifestCallbackQuerySchema = z.looseObject({
  code: z.string().optional(),
  state: z.string().optional(),
});
const installedQuerySchema = z.looseObject({
  installation_id: z.string().optional(),
  code: z.string().optional(),
  state: z.string().optional(),
});

// the admin check runs before the query is read, so a non-admin learns nothing from a 400
const projectAdmin = requiresOnParam('project.admin', 'projectId');

// a browser return answers a caller its rule refuses with the stranded page naming why, so neither
// has a floor: a door refusal would be JSON on the API's origin, which strands the App (FB-128)
const RULES = 'integration-door/github-callback-rules.ts';
const MANIFEST_CALLBACK = requiresByRule(
  `${RULES}:manifestCallbackStrand`,
  'the person the signed state names, while it is fresh, and a Forge operator; else stranded naming why',
);
const INSTALL_CALLBACK = requiresByRule(
  `${RULES}:installCallbackStrand`,
  "the person the signed state names, then org.admin on the state's organization or project.admin on the project it lands on; else stranded naming why",
);

export const githubConnectRoutes = gatedRoutes<{ Variables: AuthVars }>(
  requireAuth(),
  assertEmailVerified(),
);
export const githubCallbackRoutes = new Hono<{ Variables: AuthVars }>();
// no session, or another person's, is not provably the person the App was made for: the return
// lands naming why and spends no code (`no_session` and `email_unverified` are of that group)
githubCallbackRoutes.use(
  '/integrations/github/*',
  requireAuthOrLand((c, why) => strandedAt(c, why)),
);

/**
 * The same connect, begun on a project: the installation is recorded for the project's org, and
 * the return lands back on the project.
 */
githubConnectRoutes.post(
  '/:projectId/integrations/github/connect',
  projectAdmin,
  zValidator('query', projectConnectQuerySchema),
  async (c) => {
    const projectId = c.req.param('projectId');
    const project = await projectOrgHead(projectId);
    if (!project) throw notFound('project');
    const { returnTo } = c.req.valid('query');
    return beginConnect(c, { orgId: project.orgId, projectId, ...(returnTo ? { returnTo } : {}) });
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
      return c.json(
        await listInstallationRepositories({
          appId,
          privateKey,
          ...(connection.ownerType === 'instance'
            ? { installations: await instanceInstallationsFor(userId, connection.id) }
            : {}),
        }),
      );
    } catch (err) {
      if (!(err instanceof SourceHostCallError)) throw err;
      throw providerRefused(
        `${err.message}, so the repositories this App can see are unknown${err.detail ? `: ${err.detail}` : ''}`,
        'GITHUB_REFUSED',
        { details: { httpStatus: err.status }, retryAt: err.retryAt },
      );
    }
  },
);

githubCallbackRoutes.get(
  '/integrations/github/manifest-callback',
  MANIFEST_CALLBACK,
  zValidator('query', manifestCallbackQuerySchema),
  async (c) => {
    const { code, state: rawState } = c.req.valid('query');
    if (!code) return strandedAt(c, 'code_missing');
    if (!rawState) return strandedAt(c, 'state_missing');
    const read = readConnectState(stateSecret(), rawState);
    const userId = c.get('userId');
    // once the state is genuine and this person's own, a strand may spend the code to name the App
    // it strands; before, it may not: a forged or foreign return would spend somebody else's code
    const strand = await manifestCallbackStrand(userId, read);
    if (strand) {
      return strandedAt(c, strand, strandMayNameApp(strand) ? await nameStrandedApp(code) : null);
    }
    if (!read.ok) return strandedAt(c, 'state_expired'); // the rule stranded it already; for the type
    const state = read.state;
    if (!isVaultConfigured()) return strandedAt(c, 'vault_missing', await nameStrandedApp(code));
    if ((await findInstanceGithubApp()) || (await findAppsAwaitingCompletion()).length > 0) {
      return strandedAt(c, 'app_exists', await nameStrandedApp(code));
    }

    let app: ConvertedApp;
    try {
      app = await convertManifestCode({ code });
    } catch (err) {
      logger.warn({ err, userId }, 'github: the manifest code did not convert');
      return strandedAt(c, 'conversion_failed');
    }

    let connection: IntegrationConnectionRow;
    try {
      connection = await createConnection({
        ownerType: 'instance',
        ownerId: INSTANCE_OWNER_ID,
        provider: 'github',
        displayName: app.slug ? `GitHub App ${app.slug}` : 'GitHub App',
        config: {
          ...(app.slug ? { appSlug: app.slug } : {}),
          ...(app.owner ? { appOwner: app.owner.login, appOwnerIsOrg: app.owner.isOrg } : {}),
        },
        secrets: {
          appId: app.appId,
          privateKey: app.privateKey,
          webhookSecret: app.webhookSecret,
          ...(app.clientId ? { clientId: app.clientId } : {}),
          ...(app.clientSecret ? { clientSecret: app.clientSecret } : {}),
        },
      });
    } catch (err) {
      if (isUniqueViolation(err)) return strandedAt(c, 'app_exists', app);
      logger.error({ err, appId: app.appId }, 'github: saving the App failed');
      return strandedAt(c, 'save_failed', app);
    }

    logger.info(
      { appId: app.appId, connectionId: connection.id },
      "github: the instance's App created from manifest",
    );

    if (!app.slug) return c.redirect(await finishedAt(state, connection.id));
    // the install step carries the state on, so the return after it knows the org the
    // installation is recorded for and the page the flow began on without guessing
    const onward = signConnectState(stateSecret(), { ...state, connectionId: connection.id });
    return c.redirect(installUrl(app.slug, onward));
  },
);

/**
 * GitHub's return from an install. The instance's App asks for OAuth on install, so its return
 * carries a `code`: the installation is recorded only once GitHub's answer to that person lists it,
 * for the org the signed state names, and a forged `installation_id` records nothing. A return with
 * no code is from an App a person or org owns, made before the instance had one, and resolves as it
 * always has.
 */
githubCallbackRoutes.get(
  '/integrations/github/installed',
  INSTALL_CALLBACK,
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
    const strand = await installCallbackStrand(userId, read);
    if (strand) return strandedAt(c, strand);
    const state = read && 'state' in read ? read.state : null;

    if (query.code) {
      if (!state || !read) return strandedAt(c, 'state_missing');
      if (!read.ok) return strandedAt(c, 'state_expired');
      return recordProvenInstall(c, { read, state, code: query.code, installationId });
    }

    const owner = state?.connectionId
      ? null
      : await findConnectionOwningInstallation({
          scope: { userId, administeredProjectIds: await projectsAdministeredBy(userId) },
          installationId,
        });
    const connectionId = state?.connectionId ?? owner?.connection.id ?? null;
    if (!connectionId) return strandedAt(c, 'install_unmatched');
    // the instance's App proves an install only by the OAuth code its return carries; one with
    // none came from an App not asking for OAuth on install, and records nothing
    if ((await findInstanceGithubApp())?.id === connectionId) {
      logger.warn(
        { connectionId, installationId },
        "github: the instance App's install returned no OAuth code; turn on 'Request user authorization (OAuth) during installation' on its GitHub settings",
      );
      return strandedAt(c, 'install_unproven');
    }
    const projectId = state?.projectId ?? owner?.projectId ?? null;
    if (!projectId) return c.redirect(await finishedAt({ returnTo: 'integrations' }, connectionId));
    const notAdmin = await installCallbackStrand(userId, read, { projectId });
    if (notAdmin) return strandedAt(c, notAdmin);
    return c.redirect(
      await finishedAt(
        { projectId, ...(state?.returnTo ? { returnTo: state.returnTo } : {}) },
        connectionId,
      ),
    );
  },
);

async function recordProvenInstall(
  c: Context<{ Variables: AuthVars }>,
  args: { read: ConnectStateRead; state: ConnectState; code: string; installationId: number },
): Promise<Response> {
  const { read, state, code, installationId } = args;
  const userId = state.userId;
  if (!state.orgId) return strandedAt(c, 'state_missing');
  const notAdmin = await installCallbackStrand(userId, read, { orgId: state.orgId });
  if (notAdmin) return strandedAt(c, notAdmin);
  const app = await findInstanceGithubApp();
  if (!app) return strandedAt(c, 'install_unmatched');
  const secrets = decryptConnectionSecrets<{
    appId?: string;
    clientId?: string;
    clientSecret?: string;
  }>(app);
  if (!secrets.appId || !secrets.clientId || !secrets.clientSecret) {
    logger.warn(
      { connectionId: app.id, installationId },
      "github: the instance's App holds no OAuth client, so the install cannot be proven",
    );
    return strandedAt(c, 'install_unproven');
  }

  let proof: Awaited<ReturnType<typeof proveInstallation>>;
  try {
    proof = await proveInstallation({
      code,
      installationId,
      appId: secrets.appId,
      clientId: secrets.clientId,
      clientSecret: secrets.clientSecret,
    });
  } catch (err) {
    logger.warn({ err, installationId }, 'github: asking GitHub to prove the install failed');
    proof = { ok: false, reason: 'GitHub could not be asked' };
  }
  if (!proof.ok) {
    logger.warn(
      { connectionId: app.id, installationId, userId, reason: proof.reason },
      'github: install not proven; nothing recorded',
    );
    return strandedAt(c, 'install_unproven');
  }

  const outcome = await recordInstallation({
    connectionId: app.id,
    installationId,
    accountLogin: proof.account.login,
    accountType: proof.account.type,
    orgId: state.orgId,
    recordedBy: userId,
    proof: 'oauth',
  });
  if (!outcome.ok) {
    logger.warn(
      { connectionId: app.id, installationId, orgId: state.orgId, claimedBy: outcome.claimedBy },
      'github: install already recorded for another org; not moved',
    );
    return strandedAt(c, 'install_claimed_elsewhere');
  }
  logger.info(
    { connectionId: app.id, installationId, orgId: state.orgId, account: proof.account.login },
    'github: installation recorded',
  );
  return c.redirect(await finishedAt(state, app.id));
}
