import { Hono } from 'hono';
import { effectiveConfig, listActiveBindingsForProjectProvider } from '../integrations/index.js';
import type { PostmanConfig } from '../integrations/postman/index.js';
import { type AuthVars, assertEmailVerified, requireAuth } from '../middleware/auth.js';
import { requireCan } from '../permissions/index.js';

export const integrationTargetRoutes = new Hono<{ Variables: AuthVars }>();
integrationTargetRoutes.use('*', requireAuth(), assertEmailVerified());

integrationTargetRoutes.get('/:projectId/integrations/postman-target', async (c) => {
  const projectId = c.req.param('projectId');
  await requireCan({ userId: c.get('userId') }, 'project.read', projectId);

  const [pair] = await listActiveBindingsForProjectProvider(projectId, 'postman');
  if (!pair) return c.json({ configured: false });

  const config = effectiveConfig<PostmanConfig>(pair);
  return c.json({
    configured: true,
    workspaceId: config.workspaceId ?? null,
    workspaceName: config.workspaceName ?? null,
    collectionId: config.collectionId ?? null,
    region: config.region ?? 'us',
    mode: config.mode ?? 'minimal',
  });
});
