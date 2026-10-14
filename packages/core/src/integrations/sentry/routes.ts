/**
 * The Sentry project picker over REST (ISS-1380), registered ONTO `integrationsRoutes` for the
 * reason `coolify/routes.ts` gives: a second router mounted on `/api/projects` would put another
 * auth chain in front of every project route.
 */

import type { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import { answer } from '../../api-reference/declare/describe.js';
import { declaresInput } from '../../api-reference/declare/validator.js';
import type { AuthVars } from '../../middleware/auth.js';
import { isPreviousCredentialValid } from '../rotation.js';
import { assertAdmin, assertProjectMember, notFound } from '../route-helpers.js';
import { buildContextFromBinding, findBindingWithConnectionById } from '../store.js';
import { listSentryProjects, type SentryProjectsAuth } from './projects.js';
import { isSentryRefusal } from './refusals.js';
import {
  listSentryProjectsOperation,
  sentryProjectsBodySchema,
  sentryProjectsSchema,
} from './routes-reference.js';
import type { SentryConfig, SentrySecrets } from './types.js';

export function registerSentryRoutes(routes: Hono<{ Variables: AuthVars }>): void {
  routes.post(
    '/:projectId/integrations/sentry/projects',
    ...listSentryProjectsOperation,
    declaresInput('json', sentryProjectsBodySchema),
    async (c) => {
      const projectId = c.req.param('projectId');
      assertAdmin(await assertProjectMember(projectId, c.get('userId')));
      const parsed = sentryProjectsBodySchema.safeParse(await c.req.json().catch(() => ({})));
      if (!parsed.success) {
        throw new HTTPException(400, {
          message: 'Invalid input',
          cause: { code: 'BAD_REQUEST', details: z.flattenError(parsed.error) },
        });
      }
      const body = parsed.data;

      let auth: SentryProjectsAuth;
      if ('integrationId' in body) {
        const existing = await findBindingWithConnectionById(body.integrationId);
        if (
          !existing ||
          existing.binding.projectId !== projectId ||
          existing.binding.provider !== 'sentry'
        ) {
          throw notFound();
        }
        const ctx = buildContextFromBinding<SentryConfig, SentrySecrets>(existing);
        if (!ctx.config?.host || !ctx.secrets?.authToken) {
          throw new HTTPException(409, {
            message: 'sentry connection is missing its host or auth token',
            cause: { code: 'MISSING_CREDENTIALS' },
          });
        }
        auth = {
          host: ctx.config.host,
          authToken: ctx.secrets.authToken,
          ...(ctx.secrets.previousAuthToken && isPreviousCredentialValid(ctx.secrets)
            ? { previousAuthToken: ctx.secrets.previousAuthToken }
            : {}),
        };
      } else {
        auth = { host: body.host, authToken: body.authToken };
      }

      try {
        return c.json(
          answer(sentryProjectsSchema, await listSentryProjects(auth, body.organizationSlug)),
        );
      } catch (err) {
        // 424 and not the 502 the deploy writes answer: Cloudflare replaces an origin 502's body with
        // its own, and this refusal's whole content is the sentence naming what Sentry did (ISS-1194).
        if (isSentryRefusal(err)) {
          throw new HTTPException(424, {
            message: err.message,
            cause: {
              code: 'SENTRY_REFUSED',
              details: { reason: err.reason, httpStatus: err.httpStatus },
            },
          });
        }
        throw err;
      }
    },
  );
}
