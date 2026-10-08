/**
 * ISS-55 — an issue's criteria and the verdicts on them, over REST. Transport only: the rules are
 * `store.ts` and `verdict-input.ts`, which every door calls.
 *
 *   GET  /api/issues/:id/criteria   live criteria in order, each with its latest verdict
 *   PUT  /api/issues/:id/criteria   the plan step's write: replace the criteria (renders the text)
 *   POST /api/issues/:id/criteria/traces   tie it to business criteria of its requirement (appends)
 *   POST /api/issues/:id/verdicts   one verdict on one criterion
 */

import { Hono } from 'hono';
import { egressForRequest } from '../../lib/data-egress.js';
import {
  type AuthVars,
  assertEmailVerified,
  requireAuth,
  restActor,
} from '../../middleware/auth.js';
import { idParamSchema } from '../../middleware/route-errors.js';
import { zValidator } from '../../middleware/zod-validator.js';
import { heldIssue } from '../issue-route-ref.js';
import { criteriaPutSchema, criteriaTracePostSchema, verdictPostSchema } from './input-schemas.js';
import {
  addVerdict,
  readCriteriaWithDrafts as readCriteria,
  replaceCriteria,
  traceCriteria,
} from './service.js';

export const issueCriteriaRoutes = new Hono<{ Variables: AuthVars }>();

issueCriteriaRoutes.use('/:id/criteria', requireAuth(), assertEmailVerified());
issueCriteriaRoutes.use('/:id/criteria/traces', requireAuth(), assertEmailVerified());
issueCriteriaRoutes.use('/:id/verdicts', requireAuth(), assertEmailVerified());

/** An issue's criteria as this caller may read them: every answer passes the same egress. */
async function criteriaShown(
  agency: Parameters<typeof egressForRequest>[0],
  issue: Parameters<typeof readCriteria>[0] & { projectId: string; id: string },
) {
  return egressForRequest(
    agency,
    issue.projectId,
    'issue.criteria',
    await readCriteria(issue),
    `the criteria of ${issue.id}`,
  );
}

issueCriteriaRoutes.get('/:id/criteria', zValidator('param', idParamSchema), async (c) => {
  const { id } = c.req.valid('param');
  const issue = await heldIssue(id, c.get('userId'), 'project.read');
  return c.json({ criteria: await criteriaShown(c.get('agency'), issue) });
});

issueCriteriaRoutes.put(
  '/:id/criteria',
  zValidator('param', idParamSchema),
  zValidator('json', criteriaPutSchema),
  async (c) => {
    const { id } = c.req.valid('param');
    const { criteria } = c.req.valid('json');
    const issue = await heldIssue(id, c.get('userId'), 'project.write');
    await replaceCriteria(id, criteria);
    return c.json({ criteria: await criteriaShown(c.get('agency'), issue) });
  },
);

issueCriteriaRoutes.post(
  '/:id/criteria/traces',
  zValidator('param', idParamSchema),
  zValidator('json', criteriaTracePostSchema),
  async (c) => {
    const { id } = c.req.valid('param');
    const { codes } = c.req.valid('json');
    const issue = await heldIssue(id, c.get('userId'), 'project.write');
    await traceCriteria(issue.id, codes);
    return c.json({ criteria: await criteriaShown(c.get('agency'), issue) }, 201);
  },
);

issueCriteriaRoutes.post(
  '/:id/verdicts',
  zValidator('param', idParamSchema),
  zValidator('json', verdictPostSchema),
  async (c) => {
    const { id } = c.req.valid('param');
    const body = c.req.valid('json');
    const issue = await heldIssue(id, c.get('userId'), 'project.write');
    const written = await addVerdict({
      issue,
      draft: {
        criterion: body.criterion,
        verdict: body.verdict,
        reason: body.reason ?? null,
        identity: body.identity ?? null,
        evidence: body.evidence ?? [],
      },
      author: {
        userId: c.get('userId'),
        deviceId: c.get('patDeviceId') ?? null,
        agency: restActor(c).agency,
      },
    });
    const criterion = (await readCriteria(issue)).find((row) => row.n === body.criterion);
    return c.json({ verdictId: written.id, criterion }, 201);
  },
);
