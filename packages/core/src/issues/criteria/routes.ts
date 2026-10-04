/**
 * ISS-55 — an issue's criteria and the verdicts on them, over REST. Transport only: the rules are
 * `store.ts` and `verdict-input.ts`, which every door calls.
 *
 *   GET  /api/issues/:id/criteria   live criteria in order, each with its latest verdict
 *   PUT  /api/issues/:id/criteria   the plan step's write: replace the criteria (renders the text)
 *   POST /api/issues/:id/verdicts   one verdict on one criterion
 */

import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import { loadProjectAccess } from '../../lib/authz.js';
import { egressForRequest } from '../../lib/data-egress.js';
import {
  type AuthVars,
  assertEmailVerified,
  requireAuth,
  restActor,
} from '../../middleware/auth.js';
import { idParamSchema } from '../../middleware/route-errors.js';
import { zValidator } from '../../middleware/zod-validator.js';
import { requireHeld } from '../../permissions/index.js';
import { criteriaPutSchema, verdictPostSchema } from './input-schemas.js';
import { issueScopeOf } from '../read-service.js';
import { addVerdict, readCriteriaWithDrafts as readCriteria, replaceCriteria } from './service.js';

const badInput = (r: { success: boolean; error?: z.core.$ZodError }) => {
  if (!r.success) {
    throw new HTTPException(400, {
      message: 'Invalid input',
      cause: { code: 'BAD_REQUEST', details: r.error ? r.error : undefined },
    });
  }
};

async function issueFor(id: string, userId: string, permission: 'project.read' | 'project.write') {
  const issue = await issueScopeOf(id);
  if (!issue) throw new HTTPException(404, { message: 'issue not found' });
  requireHeld(await loadProjectAccess(issue.projectId, userId), permission);
  return { id: issue.id, projectId: issue.projectId };
}

export const issueCriteriaRoutes = new Hono<{ Variables: AuthVars }>();

issueCriteriaRoutes.use('/:id/criteria', requireAuth(), assertEmailVerified());
issueCriteriaRoutes.use('/:id/verdicts', requireAuth(), assertEmailVerified());

issueCriteriaRoutes.get(
  '/:id/criteria',
  zValidator('param', idParamSchema, badInput),
  async (c) => {
    const { id } = c.req.valid('param');
    const issue = await issueFor(id, c.get('userId'), 'project.read');
    const criteria = await egressForRequest(
      c.get('agency'),
      issue.projectId,
      'issue.criteria',
      await readCriteria(issue),
      `the criteria of ${issue.id}`,
    );
    return c.json({ criteria });
  },
);

issueCriteriaRoutes.put(
  '/:id/criteria',
  zValidator('param', idParamSchema, badInput),
  zValidator('json', criteriaPutSchema, badInput),
  async (c) => {
    const { id } = c.req.valid('param');
    const { criteria } = c.req.valid('json');
    const issue = await issueFor(id, c.get('userId'), 'project.write');
    await replaceCriteria(id, criteria);
    return c.json({ criteria: await readCriteria(issue) });
  },
);

issueCriteriaRoutes.post(
  '/:id/verdicts',
  zValidator('param', idParamSchema, badInput),
  zValidator('json', verdictPostSchema, badInput),
  async (c) => {
    const { id } = c.req.valid('param');
    const body = c.req.valid('json');
    const issue = await issueFor(id, c.get('userId'), 'project.write');
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
