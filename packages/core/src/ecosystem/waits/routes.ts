import {
  ADD_CONTRACT_WAIT_SHAPE,
  addContractWaitRequestSchema,
  type ContractWaitListResponse,
  type ContractWaitResponse,
  RETRACT_CONTRACT_WAIT_SHAPE,
  retractContractWaitRequestSchema,
} from '@forge/contracts/contract-waits';
import { eq } from 'drizzle-orm';
import { type Context, Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import { db } from '../../db/client.js';
import { issues } from '../../db/schema.js';
import { refused } from '../../lib/refusal.js';
import {
  type AuthVars,
  assertEmailVerified,
  requireAuth,
  restActor,
} from '../../middleware/auth.js';
import { strictBody, zValidator } from '../../middleware/zod-validator.js';
import { requireCan } from '../../permissions/index.js';
import { issueContractWaitsOf } from './read.js';
import { addContractWait, retractContractWait, type WaitOutcome } from './service.js';

export const contractWaitRoutes = new Hono<{ Variables: AuthVars }>();

for (const path of ['/:id/contract-waits', '/:id/contract-waits/*']) {
  contractWaitRoutes.use(path, requireAuth(), assertEmailVerified());
}

const badRequest = (message: string) =>
  new HTTPException(400, { message, cause: { code: 'BAD_REQUEST' } });

const issueParam = zValidator('param', z.object({ id: z.uuid() }), (r) => {
  if (!r.success) throw badRequest('invalid path: the issue id is a uuid');
});

const waitParam = zValidator('param', z.object({ id: z.uuid(), wid: z.uuid() }), (r) => {
  if (!r.success) throw badRequest('invalid path: an issue uuid and a contract wait uuid');
});

const listQuery = zValidator(
  'query',
  z.strictObject({ retracted: z.enum(['true', 'false']).optional() }),
  (r) => {
    if (!r.success) throw badRequest('invalid query: retracted is "true" or "false"');
  },
);

async function issueFor(id: string, userId: string) {
  const [issue] = await db
    .select({ id: issues.id, projectId: issues.projectId })
    .from(issues)
    .where(eq(issues.id, id))
    .limit(1);
  if (!issue) throw new HTTPException(404, { message: `issue ${id} not found` });
  await requireCan({ userId }, 'project.read', issue.projectId);
  return issue;
}

const actorOf = (c: Context<{ Variables: AuthVars }>) => {
  const a = restActor(c);
  return { userId: a.id, agency: a.agency };
};

function answer(c: Context, outcome: WaitOutcome) {
  if (!outcome.ok) return refused(c, outcome.refusals, 'ECOSYSTEM_REFUSED');
  const body: ContractWaitResponse = { wait: outcome.wait };
  return c.json(body, outcome.created ? 201 : 200);
}

contractWaitRoutes.get('/:id/contract-waits', issueParam, listQuery, async (c) => {
  const { id } = c.req.valid('param');
  const issue = await issueFor(id, c.get('userId'));
  const body: ContractWaitListResponse = await issueContractWaitsOf(issue.id, issue.projectId, {
    includeRetracted: c.req.valid('query').retracted === 'true',
  });
  return c.json(body);
});

contractWaitRoutes.post(
  '/:id/contract-waits',
  issueParam,
  strictBody(addContractWaitRequestSchema, ADD_CONTRACT_WAIT_SHAPE),
  async (c) => {
    const { id } = c.req.valid('param');
    const issue = await issueFor(id, c.get('userId'));
    return answer(
      c,
      await addContractWait({
        issueId: issue.id,
        projectId: issue.projectId,
        actor: actorOf(c),
        request: c.req.valid('json'),
      }),
    );
  },
);

contractWaitRoutes.post(
  '/:id/contract-waits/:wid/retract',
  waitParam,
  strictBody(retractContractWaitRequestSchema, RETRACT_CONTRACT_WAIT_SHAPE),
  async (c) => {
    const { id, wid } = c.req.valid('param');
    const issue = await issueFor(id, c.get('userId'));
    const outcome = await retractContractWait({
      issueId: issue.id,
      projectId: issue.projectId,
      waitId: wid,
      actor: actorOf(c),
      reason: c.req.valid('json').reason,
    });
    if (!outcome)
      throw new HTTPException(404, { message: `issue ${id} holds no contract wait ${wid}` });
    return answer(c, outcome);
  },
);
