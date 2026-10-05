/**
 * The Coolify deploy commands over REST, so an agent on the CLI can reach them
 * without `forge_coolify_deploy`.
 *
 * Registered ONTO `integrationsRoutes` rather than mounted as a second router
 * on `/api/projects`: a sub-app's `use('*')` covers every path under its mount
 * prefix whether or not it handles them (ISS-719), so a second router there
 * would put another auth chain in front of every project route. The handlers
 * live here to keep routes.ts inside its size budget; the registration is two
 * lines there.
 *
 * `coolify` is a literal segment among sibling routes that take `:id`. No GET
 * on `/:projectId/integrations/:id` exists today, so nothing shadows it — but
 * adding one would, and no test here can see that happen.
 *
 * `confirm-prod-deploy` moved here from routes.ts with the rest: it is a
 * Coolify route that happened to live in the provider-agnostic file.
 */

import type { Context, Hono, MiddlewareHandler } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import {
  type CoolifyConfig,
  type CoolifySecrets,
  credentialFromSecrets,
  fetchCoolifyApplications,
} from '../integrations/deploy/index.js';
import {
  buildContextFromBinding,
  findBindingWithConnectionById,
  notFound,
} from '../integrations/index.js';
import type { AuthVars } from '../middleware/auth.js';
import { zValidator } from '../middleware/zod-validator.js';
import { actorFor, projectResource, requireCan } from '../permissions/index.js';
import { announceIntegrationChanged } from '../project-config/index.js';
import {
  coolifyDeliveryStatus,
  listCoolifyIntegrations,
  listCoolifyRollbackImages,
  refuseCoolify,
  resolveCoolifyTargets,
  runCoolifyCancel,
  runCoolifyDeploy,
  runCoolifyRollback,
} from '../release-batch/index.js';
import { coolifyRefusal, given, requireCoolifyRun } from './coolify-access.js';

const deployBodySchema = z
  .object({
    issueId: z.uuid().optional(),
    pipelineRunId: z.uuid().optional(),
    integrationId: z.uuid().optional(),
  })
  .strict();

const cancelBodySchema = z
  .object({
    integrationId: z.uuid().optional(),
    deploymentUuid: z.string().min(1).max(200).optional(),
  })
  .strict();

const rollbackBodySchema = z
  .object({
    integrationId: z.uuid().optional(),
    resourceUuid: z.string().min(1).max(200).optional(),
    commit: z.string().min(1).max(200),
  })
  .strict();

const applicationsBodySchema = z.union([
  z.object({ integrationId: z.uuid() }).strict(),
  z.object({ baseUrl: z.string().url().max(500), apiToken: z.string().min(8).max(2000) }).strict(),
]);

const integrationQuerySchema = z.object({ integrationId: z.string().optional() });

const rollbackImagesQuerySchema = z.object({
  integrationId: z.string().optional(),
  resourceUuid: z.string().optional(),
});

// Membership is refused before the input is read, so a stranger learns nothing from a 400.
const projectMember: MiddlewareHandler<{ Variables: AuthVars }> = async (c, next) => {
  await requireCan(
    actorFor(c.get('userId')),
    'project.read',
    projectResource(c.req.param('projectId') ?? ''),
  );
  await next();
};

const coolifyRun =
  (act: 'deploy' | 'cancel' | 'rollback'): MiddlewareHandler<{ Variables: AuthVars }> =>
  async (c, next) => {
    await requireCoolifyRun(actorFor(c.get('userId')), c.req.param('projectId') ?? '', act);
    await next();
  };

/** Coolify's own answer, named: unmapped it reached the caller as a bare INTERNAL_ERROR (ISS-1346). */
async function answer(c: Context, run: () => Promise<unknown>): Promise<Response> {
  try {
    return c.json(await run());
  } catch (err) {
    const said = coolifyRefusal(err);
    if (said === null) throw err;
    throw new HTTPException(502, { message: said, cause: { code: 'COOLIFY_API_ERROR' } });
  }
}

type Routes = Hono<{ Variables: AuthVars }>;

export function registerCoolifyDeployRoutes(routes: Routes): void {
  registerCommandRoutes(routes);
  registerSetupRoutes(routes);
}

/** Deploy, cancel and roll back, and the reads that show where they stand. */
function registerCommandRoutes(routes: Routes): void {
  routes.get(
    '/:projectId/integrations/coolify/status',
    projectMember,
    zValidator('query', integrationQuerySchema),
    (c) => {
      const { integrationId } = c.req.valid('query');
      const projectId = c.req.param('projectId');
      return answer(c, () => coolifyDeliveryStatus({ projectId, ...given({ integrationId }) }));
    },
  );
  routes.post(
    '/:projectId/integrations/coolify/deploy',
    coolifyRun('deploy'),
    zValidator('json', deployBodySchema),
    (c) =>
      answer(c, () =>
        runCoolifyDeploy({ projectId: c.req.param('projectId'), ...c.req.valid('json') }),
      ),
  );
  routes.post(
    '/:projectId/integrations/coolify/cancel',
    coolifyRun('cancel'),
    zValidator('json', cancelBodySchema),
    (c) =>
      answer(c, () =>
        runCoolifyCancel({ projectId: c.req.param('projectId'), ...c.req.valid('json') }),
      ),
  );
  routes.get(
    '/:projectId/integrations/coolify/rollback-images',
    projectMember,
    zValidator('query', rollbackImagesQuerySchema),
    (c) => {
      const { integrationId, resourceUuid } = c.req.valid('query');
      const projectId = c.req.param('projectId');
      return answer(c, () =>
        listCoolifyRollbackImages({
          projectId,
          ...given({ integrationId, resourceUuid }),
        }),
      );
    },
  );
  routes.post(
    '/:projectId/integrations/coolify/rollback',
    coolifyRun('rollback'),
    zValidator('json', rollbackBodySchema),
    (c) =>
      answer(c, () =>
        runCoolifyRollback({ projectId: c.req.param('projectId'), ...c.req.valid('json') }),
      ),
  );
}

/** What a binding is set up with: its integrations, the applications to pick, the bound targets. */
function registerSetupRoutes(routes: Routes): void {
  routes.get('/:projectId/integrations/coolify', async (c) => {
    const projectId = c.req.param('projectId');
    await requireCan(actorFor(c.get('userId')), 'project.read', projectResource(projectId));
    return c.json(await listCoolifyIntegrations(projectId));
  });
  routes.post(
    '/:projectId/integrations/coolify/applications',
    projectMember,
    zValidator('json', applicationsBodySchema),
    async (c) => {
      const body = c.req.valid('json');
      const auth =
        'integrationId' in body
          ? await boundCredential(c.req.param('projectId'), body.integrationId)
          : { baseUrl: body.baseUrl, apiToken: body.apiToken };
      return c.json({ applications: (await fetchCoolifyApplications(auth)).slice(0, 500) });
    },
  );
  routes.get(
    '/:projectId/integrations/coolify/targets',
    projectMember,
    zValidator('query', integrationQuerySchema),
    (c) => {
      const { integrationId } = c.req.valid('query');
      const projectId = c.req.param('projectId');
      return answer(c, () => resolveCoolifyTargets({ projectId, ...given({ integrationId }) }));
    },
  );
  routes.post('/:projectId/integrations/:id/confirm-prod-deploy', async (c) => {
    const projectId = c.req.param('projectId');
    const id = c.req.param('id');
    await requireCan(actorFor(c.get('userId')), 'project.admin', projectResource(projectId));
    const existing = await findBindingWithConnectionById(id);
    if (!existing || existing.binding.projectId !== projectId) throw notFound();
    const { bindingReachesProduction, confirmPendingProdDeploy } = await import(
      '../release-batch/index.js'
    );
    if (!(await bindingReachesProduction(projectId, existing.binding))) {
      throw new HTTPException(400, {
        message:
          "confirm-prod-deploy is only valid on a deploy binding that reaches the project document's production environment — this one does not, so there is no production deploy for a human to confirm",
        cause: { code: 'NOT_LIVE_BINDING' },
      });
    }
    const result = await confirmPendingProdDeploy(id);
    await announceIntegrationChanged(projectId, {
      bindingId: id,
      connectionId: existing.connection.id,
    });
    return c.json(result);
  });
}

async function boundCredential(projectId: string, integrationId: string) {
  const existing = await findBindingWithConnectionById(integrationId);
  if (
    !existing ||
    existing.binding.projectId !== projectId ||
    existing.binding.provider !== 'coolify'
  ) {
    throw notFound();
  }
  const ctx = buildContextFromBinding<CoolifyConfig, CoolifySecrets>(existing);
  if (!ctx.config?.baseUrl || !ctx.secrets?.apiToken) {
    throw refuseCoolify(
      'MISSING_CREDENTIALS',
      'this Coolify connection is missing its baseUrl or apiToken; reconnect it with both',
    );
  }
  return credentialFromSecrets(ctx.config, ctx.secrets);
}
