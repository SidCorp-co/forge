import { type Context, Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import { type AuthVars, assertEmailVerified, requireAuth } from '../middleware/auth.js';
import { zValidator } from '../middleware/zod-validator.js';
import { envelopeOf, refused } from '../project-config/respond.js';
import {
  createWorkflow,
  listWorkflowsAs,
  readWorkflowAs,
  updateWorkflow,
  type WorkflowOutcome,
  type WorkflowWriter,
  workflowView,
} from './service.js';

export const workflowRoutes = new Hono<{ Variables: AuthVars }>();

for (const path of ['/:id/workflows', '/:id/workflows/*']) {
  workflowRoutes.use(path, requireAuth(), assertEmailVerified());
}

const badRequest = (message: string) =>
  new HTTPException(400, { message, cause: { code: 'BAD_REQUEST' } });

const idParam = zValidator('param', z.object({ id: z.uuid() }), (r) => {
  if (!r.success) throw badRequest('invalid path: the project id is a uuid');
});

const workflowParam = zValidator('param', z.object({ id: z.uuid(), workflow: z.uuid() }), (r) => {
  if (!r.success) throw badRequest('invalid path: the project and the workflow are uuids');
});

const envelope = zValidator('json', z.unknown());

function writerOf(c: Context<{ Variables: AuthVars }>): WorkflowWriter {
  const agency = c.get('agency');
  if (!agency) throw new Error('workflows: a write reached its handler without an auth gate');
  return { userId: c.get('userId'), agency };
}

function answer(c: Context, outcome: WorkflowOutcome) {
  if (!outcome.ok) return refused(c, outcome.refusals);
  return c.json(
    { ...workflowView(outcome.row, outcome.document), created: outcome.created },
    outcome.created ? 201 : 200,
  );
}

workflowRoutes.post('/:id/workflows', idParam, envelope, async (c) => {
  const { baseRevision, document } = envelopeOf(c.req.valid('json'));
  const projectId = c.req.valid('param').id;
  return answer(
    c,
    await createWorkflow({ projectId, writer: writerOf(c), baseRevision, raw: document }),
  );
});

workflowRoutes.get('/:id/workflows', idParam, async (c) => {
  const workflows = await listWorkflowsAs(c.get('userId'), c.req.valid('param').id);
  return c.json({ workflows, returned: workflows.length });
});

workflowRoutes.get('/:id/workflows/:workflow', workflowParam, async (c) => {
  const { id, workflow } = c.req.valid('param');
  return c.json(await readWorkflowAs(c.get('userId'), id, workflow));
});

workflowRoutes.put('/:id/workflows/:workflow', workflowParam, envelope, async (c) => {
  const { baseRevision, document } = envelopeOf(c.req.valid('json'));
  const { id, workflow } = c.req.valid('param');
  return answer(
    c,
    await updateWorkflow({
      projectId: id,
      id: workflow,
      writer: writerOf(c),
      baseRevision,
      raw: document,
    }),
  );
});
