// The Issues screen's read model (`standing-read.ts`): the list under one scope, and one issue's
// standing with its step log. Read-only; every derived fact is core's, never the client's.

import { ISSUE_STANDING_SCOPES } from '@forge/contracts/issue-standing';
import { Hono } from 'hono';
import { z } from 'zod';
import { loadProjectAccess } from '../lib/authz.js';
import { egressForRequest } from '../lib/data-egress.js';
import { issueRefNeedsHeldPrefixes, parseIssueRef } from '../lib/issue-ref.js';
import { queryBadRequest } from '../lib/query-strict.js';
import { type AuthVars, assertEmailVerified, requireAuth, restActor } from '../middleware/auth.js';
import { badRequest, notFound } from '../middleware/route-errors.js';
import { zValidator } from '../middleware/zod-validator.js';
import { heldIssuePrefixes } from './issue-prefix-read.js';
import { listIssueStanding, readIssueStanding } from './standing-read.js';
import { requireHeld } from '../permissions/index.js';

const projectParam = z.object({ id: z.uuid() });
const keyParam = z.object({
  id: z.uuid(),
  key: z.string().regex(/^[A-Za-z][A-Za-z0-9]{1,5}-\d+$/),
});
const scopeQuery = z.strictObject({ scope: z.enum(ISSUE_STANDING_SCOPES).default('open') });

export const issueStandingRoutes = new Hono<{ Variables: AuthVars }>();
issueStandingRoutes.use('*', requireAuth(), assertEmailVerified());

issueStandingRoutes.get(
  '/:id/issues/standing',
  zValidator('param', projectParam, (r) => {
    if (!r.success) throw badRequest(r.error);
  }),
  zValidator('query', scopeQuery, (r) => {
    if (!r.success) throw queryBadRequest(scopeQuery, r.error);
  }),
  async (c) => {
    const { id: projectId } = c.req.valid('param');
    const { scope } = c.req.valid('query');
    const userId = c.get('userId');
    const access = await loadProjectAccess(projectId, userId);
    requireHeld(access, 'project.read');
    const listed = await listIssueStanding(projectId, scope, userId ? { userId } : null);
    return c.json(
      await egressForRequest(restActor(c).agency, projectId, 'issue', listed, 'the issue list'),
    );
  },
);

issueStandingRoutes.get(
  '/:id/issues/standing/:key',
  zValidator('param', keyParam, (r) => {
    if (!r.success) throw badRequest(r.error);
  }),
  async (c) => {
    const { id: projectId, key } = c.req.valid('param');
    const userId = c.get('userId');
    const access = await loadProjectAccess(projectId, userId);
    requireHeld(access, 'project.read');
    const parsed = parseIssueRef(
      key,
      issueRefNeedsHeldPrefixes(key) ? await heldIssuePrefixes(projectId) : [],
    );
    if (!parsed.ok) throw badRequest(parsed.message);
    const row = await readIssueStanding(projectId, parsed.issSeq, userId ? { userId } : null);
    if (!row) throw notFound(`issue ${key} not found in this project`);
    return c.json(await egressForRequest(restActor(c).agency, projectId, 'issue', row, key));
  },
);
