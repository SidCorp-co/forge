// The Issues screen's read model (`standing-read.ts`): the list under one scope, and one issue's
// standing with its step log. Read-only; every derived fact is core's, never the client's.

import { ISSUE_STANDING_SCOPES } from '@forge/contracts/issue-standing';
import { z } from 'zod';
import { egressForRequest } from '../lib/data-egress.js';
import { issueRefNeedsHeldPrefixes, parseIssueRef } from '../lib/issue-ref.js';
import { type AuthVars, assertEmailVerified, requireAuth, restActor } from '../middleware/auth.js';
import { gatedRoutes } from '../middleware/gated-routes.js';
import { badRequest, notFound } from '../middleware/route-errors.js';
import { noQuery, zValidator } from '../middleware/zod-validator.js';
import { requiresOnParam } from '../permissions/index.js';
import { heldIssuePrefixes } from './issue-prefix-read.js';
import { listIssueStanding, readIssueStanding } from './standing-read.js';

const projectParam = z.object({ id: z.uuid() });
const keyParam = z.object({
  id: z.uuid(),
  key: z.string().regex(/^[A-Za-z][A-Za-z0-9]{1,5}-\d+$/),
});
const scopeQuery = z.strictObject({ scope: z.enum(ISSUE_STANDING_SCOPES).default('open') });

export const issueStandingRoutes = gatedRoutes<{ Variables: AuthVars }>(
  requireAuth(),
  assertEmailVerified(),
);

issueStandingRoutes.get(
  '/:id/issues/standing',
  zValidator('param', projectParam),
  requiresOnParam('project.read', 'id'),
  zValidator('query', scopeQuery),
  async (c) => {
    const { id: projectId } = c.req.valid('param');
    const { scope } = c.req.valid('query');
    const listed = await listIssueStanding(projectId, scope);
    return c.json(
      await egressForRequest(restActor(c).agency, projectId, 'issue', listed, 'the issue list'),
    );
  },
);

issueStandingRoutes.get(
  '/:id/issues/standing/:key',
  zValidator('param', keyParam),
  requiresOnParam('project.read', 'id'),
  noQuery,
  async (c) => {
    const { id: projectId, key } = c.req.valid('param');
    const parsed = parseIssueRef(
      key,
      issueRefNeedsHeldPrefixes(key) ? await heldIssuePrefixes(projectId) : [],
    );
    if (!parsed.ok) throw badRequest(parsed.message);
    const row = await readIssueStanding(projectId, parsed.issSeq);
    if (!row) throw notFound(`issue ${key} not found in this project`);
    return c.json(await egressForRequest(restActor(c).agency, projectId, 'issue', row, key));
  },
);
