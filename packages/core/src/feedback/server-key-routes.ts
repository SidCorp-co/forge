/**
 * A project's feedback server keys (ISS-922): mint, list and revoke, each gated by `project.admin`
 * on the project. The gate is the permission alone, so an agent holding it mints as a person does,
 * and no fresh sign-in is asked. Mounted ahead of `routes.ts`, whose `/:id/feedback/:fb` would read
 * `server-keys` as an item key.
 */

import {
  type FeedbackServerKeyListResponse,
  type FeedbackServerKeyMintResponse,
  type FeedbackServerKeyRevokeResponse,
  MINT_FEEDBACK_SERVER_KEY_SHAPE,
  mintFeedbackServerKeyRequestSchema,
} from '@forge/contracts/feedback-server-keys';
import { Hono } from 'hono';
import { z } from 'zod';
import { refused } from '../lib/refusal.js';
import { type AuthVars, assertEmailVerified, requireAuth, restActor } from '../middleware/auth.js';
import { invalid, noQuery, strictBody, zValidator } from '../middleware/zod-validator.js';
import { requiresOnParam } from '../permissions/index.js';
import { listServerKeys, mintServerKey, revokeServerKey } from './server-keys.js';

const ADMIN = requiresOnParam('project.admin', 'id');

export const feedbackServerKeyRoutes = new Hono<{ Variables: AuthVars }>();

for (const path of ['/:id/feedback/server-keys', '/:id/feedback/server-keys/*']) {
  feedbackServerKeyRoutes.use(path, requireAuth(), assertEmailVerified());
}

const projectParam = zValidator(
  'param',
  z.object({ id: z.uuid() }),
  invalid('invalid path: the project id is a uuid'),
);

const keyParam = zValidator(
  'param',
  z.object({ id: z.uuid(), keyId: z.uuid() }),
  invalid('invalid path: a project uuid and a server key uuid'),
);

feedbackServerKeyRoutes.post(
  '/:id/feedback/server-keys',
  projectParam,
  ADMIN,
  strictBody(mintFeedbackServerKeyRequestSchema, MINT_FEEDBACK_SERVER_KEY_SHAPE),
  async (c) => {
    const { product, expiresAt } = c.req.valid('json');
    const out = await mintServerKey({
      projectId: c.req.valid('param').id,
      product,
      expiresAt: expiresAt ? new Date(expiresAt) : null,
      mintedBy: restActor(c).id,
    });
    if (!out.ok) return refused(c, out.refusals, 'FEEDBACK_SERVER_KEY_REFUSED');
    return c.json(
      { key: out.key, secret: out.secret } satisfies FeedbackServerKeyMintResponse,
      201,
    );
  },
);

feedbackServerKeyRoutes.get('/:id/feedback/server-keys', projectParam, ADMIN, noQuery, async (c) =>
  c.json({
    keys: await listServerKeys(c.req.valid('param').id),
  } satisfies FeedbackServerKeyListResponse),
);

feedbackServerKeyRoutes.delete('/:id/feedback/server-keys/:keyId', keyParam, ADMIN, async (c) => {
  const { id, keyId } = c.req.valid('param');
  const key = await revokeServerKey({ projectId: id, keyId, revokedBy: restActor(c).id });
  return c.json({ key } satisfies FeedbackServerKeyRevokeResponse);
});
