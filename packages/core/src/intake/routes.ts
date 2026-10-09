import type { IntakeDraftResponse } from '@forge/contracts/intake-drafts';
import { Hono } from 'hono';
import { z } from 'zod';
import { refused } from '../lib/refusal.js';
import { type AuthVars, assertEmailVerified, requireAuth } from '../middleware/auth.js';
import { invalid, zValidator } from '../middleware/zod-validator.js';
import { readIntakeDraft } from './read.js';

/** `GET /api/projects/:id/intake-drafts/:ref`: the intake assistant's draft of REQ-n or FB-n. */
export const intakeRoutes = new Hono<{ Variables: AuthVars }>();

intakeRoutes.use('/:id/intake-drafts/*', requireAuth(), assertEmailVerified());

const param = zValidator(
  'param',
  z.object({ id: z.uuid(), ref: z.string().trim().min(1).max(64) }),
  invalid('invalid path: a project uuid and an item key, REQ-n or FB-n'),
);

intakeRoutes.get('/:id/intake-drafts/:ref', param, async (c) => {
  const { id: projectId, ref } = c.req.valid('param');
  const agency = c.get('agency');
  if (!agency) throw new Error('intake: a request reached its handler without an auth gate');
  const out = await readIntakeDraft({
    projectId,
    ref,
    viewer: { userId: c.get('userId'), agency },
  });
  if (!out.ok) return refused(c, out.refusals, 'INTAKE_REF_INVALID');
  const body: IntakeDraftResponse = { draft: out.draft };
  return c.json(body);
});
