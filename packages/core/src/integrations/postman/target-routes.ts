import { Hono } from 'hono';
import { answer } from '../../api-reference/describe.js';
import { type AuthVars, assertEmailVerified, requireAuth } from '../../middleware/auth.js';
import { assertProjectMember } from '../route-helpers.js';
import { effectiveConfig, listActiveBindingsForProjectProvider } from '../store.js';
import { postmanTargetSchema, readPostmanTarget } from './target-routes-reference.js';
import type { PostmanConfig } from './types.js';

export const integrationTargetRoutes = new Hono<{ Variables: AuthVars }>();
integrationTargetRoutes.use('*', requireAuth(), assertEmailVerified());

integrationTargetRoutes.get(
  '/:projectId/integrations/postman-target',
  ...readPostmanTarget,
  async (c) => {
    const projectId = c.req.param('projectId');
    await assertProjectMember(projectId, c.get('userId'));

    const [pair] = await listActiveBindingsForProjectProvider(projectId, 'postman');
    if (!pair) return c.json(answer(postmanTargetSchema, { configured: false }));

    const config = effectiveConfig<PostmanConfig>(pair);
    return c.json(
      answer(postmanTargetSchema, {
        configured: true,
        workspaceId: config.workspaceId ?? null,
        workspaceName: config.workspaceName ?? null,
        collectionId: config.collectionId ?? null,
        region: config.region ?? 'us',
        mode: config.mode ?? 'minimal',
      }),
    );
  },
);
