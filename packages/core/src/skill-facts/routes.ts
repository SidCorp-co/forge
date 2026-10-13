import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import { answer } from '../api-reference/describe.js';
import { loadProjectAccess } from '../lib/authz.js';
import { type AuthVars, assertEmailVerified, requireAuth } from '../middleware/auth.js';
import { declaresInput } from '../middleware/validator.js';
import { listResolvedFacts } from '../prompt/facts/resolve.js';
import { factsQuerySchema, factsSchema, listSkillFacts } from './routes-reference.js';

export const skillFactsRoutes = new Hono<{ Variables: AuthVars }>();

/**
 * List the Forge Facts (project-resolved) a skill author can reference via
 * `{{forge:<id>}}` / `{{project:<id>}}`. Read-only. `stage` (optional) tailors
 * stage-specific facts (e.g. the `handoff` payload keys). Drives the Skill
 * Studio facts palette + resolved preview.
 */
skillFactsRoutes.get(
  '/',
  requireAuth(),
  assertEmailVerified(),
  listSkillFacts,
  declaresInput('query', factsQuerySchema),
  async (c) => {
    const parsed = factsQuerySchema.safeParse({
      projectId: c.req.query('projectId'),
      stage: c.req.query('stage'),
    });
    if (!parsed.success) {
      throw new HTTPException(400, {
        message: 'Invalid input',
        cause: { code: 'BAD_REQUEST', details: z.flattenError(parsed.error) },
      });
    }

    const userId = c.get('userId');
    const access = await loadProjectAccess(parsed.data.projectId, userId);
    if (!access.role) {
      throw new HTTPException(403, {
        message: 'not a project member',
        cause: { code: 'FORBIDDEN' },
      });
    }

    const facts = await listResolvedFacts(parsed.data.projectId, parsed.data.stage ?? null);
    return c.json(answer(factsSchema, { facts }));
  },
);
