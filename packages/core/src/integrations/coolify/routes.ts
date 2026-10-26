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

import type { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { answer } from '../../api-reference/declare/describe.js';
import { declaresInput } from '../../api-reference/declare/validator.js';
import { schemaRefused } from '../../lib/zod-sentences.js';
import type { AuthVars } from '../../middleware/auth.js';
import { DeployEnvironmentLockedError } from '../../pipeline/deploy-lock.js';
import { bindingActs, bindingReaderOf, type ProjectRole } from '../binding-acts.js';
import {
  assertAdmin,
  assertNotRemoved,
  assertProjectMember,
  assertProjectWriter,
  broadcastIntegrationChanged,
  notFound,
} from '../route-helpers.js';
import { buildContextFromBinding, findBindingWithConnectionById } from '../store.js';
import { addressForReader } from '../unreached.js';
import {
  CoolifyApiError,
  describeCoolifyAnswer,
  describeCoolifyRollbackImagesRefusal,
} from './client.js';
import {
  activeCoolifyIntegrations,
  CoolifyCommandError,
  CoolifyConnectionRemovedError,
  coolifyDeliveryStatus,
  listCoolifyIntegrations,
  offBindingRefusal,
  runCoolifyDeploy,
} from './commands.js';
import {
  credentialFromSecrets,
  fetchCoolifyApplications,
  listCoolifyRollbackImages,
  resolveCoolifyTargets,
  runCoolifyCancel,
  runCoolifyRollback,
} from './controls.js';
import { CoolifyReadFailedError } from './rollback-images-read.js';
import {
  applicationsBodySchema,
  applicationsSchema,
  cancelBodySchema,
  cancelCoolify,
  confirmedSchema,
  confirmProdDeploy,
  controlSchema,
  deliveriesSchema,
  deployBodySchema,
  deployCoolify,
  dispatchedSchema,
  integrationQuerySchema,
  integrationsSchema,
  listCoolify,
  listCoolifyApplications,
  readCoolifyStatus,
  readRollbackImages,
  readTargets,
  rollbackBodySchema,
  rollbackCoolify,
  rollbackImagesQuerySchema,
  rollbackImagesSchema,
  targetsSchema,
} from './routes-reference.js';
import type { CoolifyConfig, CoolifySecrets } from './types.js';

/** A refusal's message ends as a sentence does, whatever Coolify's own words ended on (ISS-1421 r6). */
export const asSentence = (message: string): string =>
  /[.!?]$/.test(message.trimEnd()) ? message.trimEnd() : `${message.trimEnd()}.`;

const asHttp = (err: unknown): never => {
  // A removed connection is answered as every other door over it answers (ISS-1421 r29).
  if (err instanceof CoolifyConnectionRemovedError) {
    throw new HTTPException(409, { message: err.message, cause: { code: 'CONNECTION_REMOVED' } });
  }
  if (err instanceof CoolifyCommandError) {
    throw new HTTPException(400, { message: err.message, cause: { code: 'BAD_REQUEST' } });
  }
  // Coolify's own answer, named: unmapped it reached the caller as a bare INTERNAL_ERROR (ISS-1346).
  if (err instanceof CoolifyApiError) {
    throw new HTTPException(502, {
      message: asSentence(describeCoolifyAnswer(err)),
      cause: { code: 'COOLIFY_API_ERROR' },
    });
  }
  throw err;
};

/**
 * ISS-1279 — a resumed release refused its environment carries a holder, a
 * subject, a since and what ends the hold. `errorHandler` turns anything that
 * is not an `HTTPException` into a bare `INTERNAL_ERROR` in production, so
 * without this the refusal reaches the person pressing the button as nothing
 * at all.
 */
const lockedAsHttp = (err: unknown): never => {
  if (err instanceof DeployEnvironmentLockedError) {
    throw new HTTPException(409, {
      message: err.message,
      cause: { code: 'DEPLOY_ENVIRONMENT_LOCKED' },
    });
  }
  throw err;
};

/**
 * A read of Coolify that failed, named. 424, not the 502 the writes answer: Cloudflare replaces an
 * origin 502's body with its own `error code: 502`, so the refusal named here never reached a
 * caller (ISS-1194).
 */
const readAsHttp = (
  err: unknown,
  describe: (e: CoolifyApiError) => string,
  addressWhoMay: string | null = null,
): never => {
  const forReader = (said: string) =>
    addressWhoMay === null ? said : addressForReader(said, addressWhoMay);
  if (err instanceof CoolifyApiError) {
    throw new HTTPException(424, {
      message: forReader(asSentence(describe(err))),
      cause: { code: 'COOLIFY_API_ERROR' },
    });
  }
  if (err instanceof CoolifyReadFailedError) {
    // Coolify answering something that is not JSON did reach Coolify: its own code, so a caller
    // acting on the code is not told Forge could not connect.
    const code = err.kind === 'not-json' ? 'COOLIFY_ANSWER_NOT_JSON' : 'COOLIFY_UNREACHABLE';
    throw new HTTPException(424, { message: forReader(asSentence(err.message)), cause: { code } });
  }
  return asHttp(err);
};

/**
 * Who may change the saved address of the binding a failed read went through, where this reader may
 * not; null for any other failure, or where the read resolved no one binding.
 */
async function addressWhoMayOver(
  err: unknown,
  reader: { userId: string; projectId: string; role: ProjectRole },
  integrationId: string | undefined,
): Promise<string | null> {
  if (!(err instanceof CoolifyApiError || err instanceof CoolifyReadFailedError)) return null;
  const rows = await activeCoolifyIntegrations(reader.projectId);
  const row = integrationId
    ? rows.find((r) => r.id === integrationId)
    : rows.length === 1
      ? rows[0]
      : undefined;
  if (!row) return null;
  const acts = bindingActs(
    await bindingReaderOf(reader.userId, reader.projectId, reader.role),
    row.pair.connection,
    'coolify',
  );
  return acts.saveKey ? null : acts.whoSavesKey;
}

function registerCoolifyCommandRoutes(routes: Hono<{ Variables: AuthVars }>): void {
  routes.get('/:projectId/integrations/coolify', ...listCoolify, async (c) => {
    const projectId = c.req.param('projectId');
    await assertProjectMember(projectId, c.get('userId'));
    return c.json(answer(integrationsSchema, await listCoolifyIntegrations(projectId)));
  });

  routes.get(
    '/:projectId/integrations/coolify/status',
    ...readCoolifyStatus,
    declaresInput('query', integrationQuerySchema),
    async (c) => {
      const projectId = c.req.param('projectId');
      await assertProjectMember(projectId, c.get('userId'));
      const integrationId = c.req.query('integrationId');
      try {
        return c.json(
          answer(
            deliveriesSchema,
            await coolifyDeliveryStatus({
              projectId,
              ...(integrationId ? { integrationId } : {}),
            }),
          ),
        );
      } catch (err) {
        return asHttp(err);
      }
    },
  );

  routes.post(
    '/:projectId/integrations/coolify/deploy',
    ...deployCoolify,
    declaresInput('json', deployBodySchema),
    async (c) => {
      const projectId = c.req.param('projectId');
      await assertProjectWriter(projectId, c.get('userId'), 'deploy it through Coolify');

      const raw = await c.req.json().catch(() => ({}));
      const parsed = deployBodySchema.safeParse(raw ?? {});
      if (!parsed.success) throw schemaRefused(parsed.error, deployBodySchema, raw);

      try {
        return c.json(
          answer(dispatchedSchema, await runCoolifyDeploy({ projectId, ...parsed.data })),
        );
      } catch (err) {
        return asHttp(err);
      }
    },
  );

  routes.post(
    '/:projectId/integrations/coolify/cancel',
    ...cancelCoolify,
    declaresInput('json', cancelBodySchema),
    async (c) => {
      const projectId = c.req.param('projectId');
      await assertProjectWriter(projectId, c.get('userId'), 'cancel a Coolify deploy for it');
      const raw = await c.req.json().catch(() => ({}));
      const parsed = cancelBodySchema.safeParse(raw ?? {});
      if (!parsed.success) throw schemaRefused(parsed.error, cancelBodySchema, raw);
      try {
        return c.json(answer(controlSchema, await runCoolifyCancel({ projectId, ...parsed.data })));
      } catch (err) {
        return asHttp(err);
      }
    },
  );

  routes.get(
    '/:projectId/integrations/coolify/rollback-images',
    ...readRollbackImages,
    declaresInput('query', rollbackImagesQuerySchema),
    async (c) => {
      const projectId = c.req.param('projectId');
      const userId = c.get('userId');
      const role = await assertProjectMember(projectId, userId);
      const integrationId = c.req.query('integrationId');
      const resourceUuid = c.req.query('resourceUuid');
      try {
        return c.json(
          answer(
            rollbackImagesSchema,
            await listCoolifyRollbackImages({
              projectId,
              ...(integrationId ? { integrationId } : {}),
              ...(resourceUuid ? { resourceUuid } : {}),
            }),
          ),
        );
      } catch (err) {
        const who = await addressWhoMayOver(err, { userId, projectId, role }, integrationId);
        return readAsHttp(err, describeCoolifyRollbackImagesRefusal, who);
      }
    },
  );

  routes.post(
    '/:projectId/integrations/coolify/rollback',
    ...rollbackCoolify,
    declaresInput('json', rollbackBodySchema),
    async (c) => {
      const projectId = c.req.param('projectId');
      await assertProjectWriter(projectId, c.get('userId'), 'roll it back through Coolify');
      const raw = await c.req.json().catch(() => ({}));
      const parsed = rollbackBodySchema.safeParse(raw ?? {});
      if (!parsed.success) throw schemaRefused(parsed.error, rollbackBodySchema, raw);
      try {
        return c.json(
          answer(controlSchema, await runCoolifyRollback({ projectId, ...parsed.data })),
        );
      } catch (err) {
        return asHttp(err);
      }
    },
  );
}

function registerCoolifyPickerRoutes(routes: Hono<{ Variables: AuthVars }>): void {
  routes.post(
    '/:projectId/integrations/coolify/applications',
    ...listCoolifyApplications,
    declaresInput('json', applicationsBodySchema),
    async (c) => {
      const projectId = c.req.param('projectId');
      const userId = c.get('userId');
      const role = await assertProjectMember(projectId, userId);
      const raw = await c.req.json().catch(() => ({}));
      const parsed = applicationsBodySchema.safeParse(raw ?? {});
      if (!parsed.success) throw schemaRefused(parsed.error, applicationsBodySchema, raw);
      const body = parsed.data;
      let auth: { baseUrl: string; apiToken: string; previousApiToken?: string };
      // Who may change the saved address, where this reader may not; a typed address is the reader's own.
      let addressWhoMay: string | null = null;
      if ('integrationId' in body) {
        const existing = await findBindingWithConnectionById(body.integrationId);
        if (
          !existing ||
          existing.binding.projectId !== projectId ||
          existing.binding.provider !== 'coolify'
        ) {
          throw notFound();
        }
        // Over a removed connection "missing" named no cause and no way back (ISS-1421 r26).
        await assertNotRemoved(existing.connection, 'asked for its applications', {
          userId,
          role,
          projectId,
        });
        // Switched off is refused as off, naming who switches it on, before any token leaves.
        if (!(existing.binding.active && existing.connection.active)) {
          asHttp(await offBindingRefusal(existing, projectId));
        }
        const acts = bindingActs(
          await bindingReaderOf(userId, projectId, role),
          existing.connection,
          existing.binding.provider,
        );
        addressWhoMay = acts.saveKey ? null : acts.whoSavesKey;
        const ctx = buildContextFromBinding<CoolifyConfig, CoolifySecrets>(existing);
        if (!ctx.config?.baseUrl || !ctx.secrets?.apiToken) {
          throw new HTTPException(409, {
            message: `This Coolify connection holds no ${ctx.config?.baseUrl ? 'API token' : 'base URL'}, so its applications cannot be listed.`,
            cause: { code: 'MISSING_CREDENTIALS' },
          });
        }
        auth = credentialFromSecrets(ctx.config, ctx.secrets);
      } else {
        auth = { baseUrl: body.baseUrl, apiToken: body.apiToken };
      }
      try {
        return c.json(
          answer(applicationsSchema, {
            applications: (await fetchCoolifyApplications(auth)).slice(0, 500),
          }),
        );
      } catch (err) {
        return readAsHttp(err, describeCoolifyAnswer, addressWhoMay);
      }
    },
  );

  routes.get(
    '/:projectId/integrations/coolify/targets',
    ...readTargets,
    declaresInput('query', integrationQuerySchema),
    async (c) => {
      const projectId = c.req.param('projectId');
      const userId = c.get('userId');
      const role = await assertProjectMember(projectId, userId);
      const integrationId = c.req.query('integrationId');
      try {
        return c.json(
          answer(
            targetsSchema,
            await resolveCoolifyTargets({
              projectId,
              ...(integrationId ? { integrationId } : {}),
            }),
          ),
        );
      } catch (err) {
        const who = await addressWhoMayOver(err, { userId, projectId, role }, integrationId);
        return readAsHttp(err, describeCoolifyAnswer, who);
      }
    },
  );

  routes.post(
    '/:projectId/integrations/:id/confirm-prod-deploy',
    ...confirmProdDeploy,
    async (c) => {
      const projectId = c.req.param('projectId');
      const id = c.req.param('id');
      const userId = c.get('userId');
      const role = await assertProjectMember(projectId, userId);
      assertAdmin(role, 'confirm a live deploy for it');

      const existing = await findBindingWithConnectionById(id);
      if (!existing || existing.binding.projectId !== projectId) throw notFound();
      if (!(existing.binding.stages ?? []).includes('live')) {
        throw new HTTPException(400, {
          message:
            'This Coolify binding deploys to no live environment, so it has no live deploy to confirm. Only a binding that deploys to live waits for a person to confirm.',
          cause: { code: 'NOT_LIVE_BINDING' },
        });
      }
      const { confirmPendingProdDeploy } = await import('../../pipeline/release-coolify.js');
      const result = await confirmPendingProdDeploy(id).catch(lockedAsHttp);
      broadcastIntegrationChanged(projectId, {
        bindingId: id,
        connectionId: existing.connection.id,
      });
      return c.json(answer(confirmedSchema, result));
    },
  );
}

export function registerCoolifyDeployRoutes(routes: Hono<{ Variables: AuthVars }>): void {
  registerCoolifyCommandRoutes(routes);
  registerCoolifyPickerRoutes(routes);
}
