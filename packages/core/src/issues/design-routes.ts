/**
 * An issue's design over REST (REQ-36 BC-1, BC-13; Issue lifecycle r15 `design-check`): read it with
 * the check a move into build meets, or record it whole. The rules are `design-rules.ts`, the store
 * and the check `design-record.ts`.
 *
 *   GET /api/issues/:id/design   the design, whether the project reads a catalog, and the check
 *   PUT /api/issues/:id/design   record it: each criterion's class, pattern and proof, the modules and contracts
 */

import { RECORD_DESIGN_SHAPE, recordDesignRequestSchema } from '@forge/contracts/issue-design';
import { Hono } from 'hono';
import { z } from 'zod';
import { refused } from '../lib/refusal.js';
import { type AuthVars, assertEmailVerified, requireAuth } from '../middleware/auth.js';
import { strictBody, zValidator } from '../middleware/zod-validator.js';
import { actorFor, projectResource, requireCan } from '../permissions/index.js';
import { issueDesignOf, recordDesign } from './design-record.js';
import { resolveIssueRouteRef } from './issue-route-ref.js';

const issueParam = z.object({ id: z.string().min(1) });
const scopeQuery = z.object({ projectId: z.uuid().optional() });

export const issueDesignRoutes = new Hono<{ Variables: AuthVars }>();
issueDesignRoutes.use('/:id/design', requireAuth(), assertEmailVerified());

/** GET /api/issues/:id/design — the recorded design and the check a move into build meets. */
issueDesignRoutes.get(
  '/:id/design',
  zValidator('param', issueParam),
  zValidator('query', scopeQuery),
  async (c) => {
    const issue = await resolveIssueRouteRef(
      c.req.valid('param').id,
      c.req.valid('query').projectId,
      c.get('userId'),
    );
    return c.json(await issueDesignOf(issue));
  },
);

/** PUT /api/issues/:id/design — record the design whole; a later write replaces it. */
issueDesignRoutes.put(
  '/:id/design',
  zValidator('param', issueParam),
  zValidator('query', scopeQuery),
  strictBody(recordDesignRequestSchema, RECORD_DESIGN_SHAPE),
  async (c) => {
    const userId = c.get('userId');
    const issue = await resolveIssueRouteRef(
      c.req.valid('param').id,
      c.req.valid('query').projectId,
      userId,
    );
    await requireCan(actorFor(userId), 'project.write', projectResource(issue.projectId));
    const out = await recordDesign({
      issue: { id: issue.id, projectId: issue.projectId, status: issue.status },
      body: c.req.valid('json'),
      actor: { userId, agency: c.get('agency') ?? null },
    });
    if (!out.ok) return refused(c, out.refusals, 'DESIGN_REFUSED');
    return c.json(out.value);
  },
);
