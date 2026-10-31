// Fast delivery's REST doors (REQ-79): the impact rating on an issue (BC-4), the project's cleanup
// debt (BC-3, BC-7) and its cleanup reports (BC-9). Writes need project write; reads, project read.

import {
  carryDebtRequestSchema,
  cleanupReportRequestSchema,
  recordDebtsRequestSchema,
  recordImpactRequestSchema,
} from '@forge/contracts/cleanup';
import { Hono } from 'hono';
import { z } from 'zod';
import { type AuthVars, assertEmailVerified, requireAuth } from '../middleware/auth.js';
import { noQuery, strictBody, zValidator } from '../middleware/zod-validator.js';
import {
  carryDebt,
  listCleanupReports,
  readImpacts,
  readLedger,
  recordCleanupReport,
  recordDebts,
  recordImpact,
} from './service.js';

const issueParam = zValidator('param', z.object({ id: z.string().min(1).max(200) }));
const scopeQuery = zValidator('query', z.object({ projectId: z.uuid().optional() }));
const projectParam = zValidator('param', z.object({ projectId: z.uuid() }));

export const cleanupIssueRoutes = new Hono<{ Variables: AuthVars }>();
cleanupIssueRoutes.use('/:id/impact', requireAuth(), assertEmailVerified());

cleanupIssueRoutes.post(
  '/:id/impact',
  issueParam,
  scopeQuery,
  strictBody(
    recordImpactRequestSchema,
    '{ type: ui | api | logic | data | config | runner, rating: low | medium | high, reason, commit? } rates the change this issue makes (REQ-79 BC-4)',
  ),
  async (c) => {
    const out = await recordImpact({
      issueRef: c.req.valid('param').id,
      projectId: c.req.valid('query').projectId,
      request: c.req.valid('json'),
      userId: c.get('userId'),
    });
    return c.json(out, 201);
  },
);

cleanupIssueRoutes.get('/:id/impact', issueParam, scopeQuery, async (c) =>
  c.json(
    await readImpacts({
      issueRef: c.req.valid('param').id,
      projectId: c.req.valid('query').projectId,
      userId: c.get('userId'),
    }),
  ),
);

export const cleanupProjectRoutes = new Hono<{ Variables: AuthVars }>();
cleanupProjectRoutes.use('/:projectId/debts', requireAuth(), assertEmailVerified());
cleanupProjectRoutes.use('/:projectId/cleanup-reports', requireAuth(), assertEmailVerified());

cleanupProjectRoutes.post(
  '/:projectId/debts',
  projectParam,
  strictBody(
    recordDebtsRequestSchema,
    '{ issue?, items: [{ kind: red | debt | simplify, check?, where, detail, impact: { type, rating, reason } }] } records cleanup debt (REQ-79 BC-3)',
  ),
  async (c) =>
    c.json(
      await recordDebts({
        projectId: c.req.valid('param').projectId,
        request: c.req.valid('json'),
        userId: c.get('userId'),
      }),
      201,
    ),
);

const debtParam = zValidator('param', z.object({ projectId: z.uuid(), debt: z.uuid() }));
cleanupProjectRoutes.use('/:projectId/debts/:debt/carry', requireAuth(), assertEmailVerified());

cleanupProjectRoutes.post(
  '/:projectId/debts/:debt/carry',
  debtParam,
  strictBody(
    carryDebtRequestSchema,
    '{ trades, costs, endsWhen } carries an open debt as a priced amnesty, which a cleanup report leaves without turning red (REQ-79 BC-10)',
  ),
  async (c) => {
    const { projectId, debt } = c.req.valid('param');
    return c.json(
      await carryDebt({
        projectId,
        debtId: debt,
        carry: c.req.valid('json'),
        userId: c.get('userId'),
      }),
    );
  },
);

cleanupProjectRoutes.delete('/:projectId/debts/:debt/carry', debtParam, noQuery, async (c) => {
  const { projectId, debt } = c.req.valid('param');
  return c.json(await carryDebt({ projectId, debtId: debt, carry: null, userId: c.get('userId') }));
});

cleanupProjectRoutes.get('/:projectId/debts', projectParam, noQuery, async (c) =>
  c.json(await readLedger(c.req.valid('param').projectId, c.get('userId'))),
);

cleanupProjectRoutes.post(
  '/:projectId/cleanup-reports',
  projectParam,
  strictBody(
    cleanupReportRequestSchema,
    '{ fire?, base: { branch, sha }, result: green | red, ci?, cleared: [{ debt, how }], remains: [{ debt, why }], covers?: [issue] } reports a cleanup run (REQ-79 BC-9)',
  ),
  async (c) =>
    c.json(
      await recordCleanupReport({
        projectId: c.req.valid('param').projectId,
        request: c.req.valid('json'),
        userId: c.get('userId'),
      }),
      201,
    ),
);

cleanupProjectRoutes.get('/:projectId/cleanup-reports', projectParam, noQuery, async (c) =>
  c.json(await listCleanupReports(c.req.valid('param').projectId, c.get('userId'))),
);
