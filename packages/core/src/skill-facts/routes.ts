import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import { jobTypes } from '../db/schema.js';
import { loadProjectAccess } from '../lib/authz.js';
import { type AuthVars, assertEmailVerified, requireAuth } from '../middleware/auth.js';
import { zValidator } from '../middleware/zod-validator.js';
import { listResolvedFacts } from '../prompt/facts/resolve.js';

const querySchema = z.object({
  projectId: z.uuid(),
  stage: z.enum(jobTypes).optional(),
});

export const skillFactsRoutes = new Hono<{ Variables: AuthVars }>();

/**
 * List the Forge Facts (project-resolved) a skill author can reference via
 * `{{forge:<id>}}` / `{{project:<id>}}`. Read-only. `stage` (optional) tailors
 * stage-specific facts (e.g. the `handoff` payload keys). Drives the Skill
 * Studio facts palette + resolved preview.
 */
const validQuery = zValidator('query', querySchema, (result) => {
  if (!result.success) {
    throw new HTTPException(400, {
      message: 'Invalid input',
      cause: { code: 'BAD_REQUEST', details: z.flattenError(result.error) },
    });
  }
});

skillFactsRoutes.get('/', requireAuth(), assertEmailVerified(), validQuery, async (c) => {
  const query = c.req.valid('query');

  const userId = c.get('userId');
  const access = await loadProjectAccess(query.projectId, userId);
  if (!access.role) {
    throw new HTTPException(403, { message: 'not a project member', cause: { code: 'FORBIDDEN' } });
  }

  const facts = await listResolvedFacts(query.projectId, query.stage ?? null);
  return c.json({ facts });
});
