/**
 * Write-target reads: WHERE a skill should write its artifact for a given
 * provider, with no credential attached.
 *
 * Its own router rather than a branch of `integrations/routes.ts` because the
 * safe projection is a per-provider fact — see the guard below — so this file
 * grows one small handler per provider that has a write target.
 */

import { Hono } from 'hono';
import { type AuthVars, assertEmailVerified, requireAuth } from '../middleware/auth.js';
import type { PostmanConfig } from './postman/types.js';
import { assertProjectMember } from './route-helpers.js';
import { effectiveConfig, listActiveBindingsForProjectProvider } from './store.js';

export const integrationTargetRoutes = new Hono<{ Variables: AuthVars }>();
integrationTargetRoutes.use('*', requireAuth(), assertEmailVerified());

// cm:guard project the safe fields BY NAME and never spread `effectiveConfig` — the same record holds the Postman API key, which reaches a runner only through the injected `mcpServers.postman` entry and must never come back over a read surface. This is also why there is no generic `/integrations/:provider/target`: which fields are safe is a per-provider fact, so each write-target read spells its own out.
integrationTargetRoutes.get('/:projectId/integrations/postman-target', async (c) => {
  const projectId = c.req.param('projectId');
  await assertProjectMember(projectId, c.get('userId'));

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
