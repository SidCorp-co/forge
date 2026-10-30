/**
 * A design the requirement an issue delivers links or pins, over REST, read through the issue:
 *
 *   GET /api/issues/:id/requirement/designs/:workflow   the steps view of that design
 *                                                        (`issue-design-read.ts`), at `revision?`
 *                                                        and `stepFrom?`..`stepTo?`
 *
 * The caller is authorised on the issue's project alone (`project.read`), a person and an agent
 * alike, so a credential fenced to the issue's project reads the designs a sibling project's
 * requirement it delivers pins. The design leaves under its own project's data policy.
 */

import { Hono } from 'hono';
import { z } from 'zod';
import { resolveIssueRouteRef } from '../issues/index.js';
import { egressForRequest } from '../lib/data-egress.js';
import { type AuthVars, assertEmailVerified, requireAuth } from '../middleware/auth.js';
import { invalid, zValidator } from '../middleware/zod-validator.js';
import { issueRequirementDesignOf } from './issue-design-read.js';

export const issueRequirementDesignRoutes = new Hono<{ Variables: AuthVars }>();

issueRequirementDesignRoutes.use(
  '/:id/requirement/designs/:workflow',
  requireAuth(),
  assertEmailVerified(),
);

const params = zValidator(
  'param',
  z.object({ id: z.uuid(), workflow: z.uuid() }),
  invalid('invalid path: the issue and the workflow are uuids'),
);

const range = zValidator(
  'query',
  z.strictObject({
    revision: z.coerce.number().int().min(1).optional(),
    stepFrom: z.coerce.number().int().min(1).optional(),
    stepTo: z.coerce.number().int().min(1).optional(),
  }),
  invalid(
    'invalid query: revision?, stepFrom?, stepTo? (whole numbers from 1); this read answers the steps view',
  ),
);

issueRequirementDesignRoutes.get('/:id/requirement/designs/:workflow', params, range, async (c) => {
  const { id, workflow } = c.req.valid('param');
  const q = c.req.valid('query');
  const issue = await resolveIssueRouteRef(id, undefined, c.get('userId'));
  const read = await issueRequirementDesignOf(issue.id, workflow, {
    revision: q.revision,
    from: q.stepFrom,
    to: q.stepTo,
  });
  return c.json(
    await egressForRequest(
      c.get('agency'),
      read.projectId,
      'design',
      read.design,
      `workflow ${workflow}, read through issue ${issue.id}`,
    ),
  );
});
