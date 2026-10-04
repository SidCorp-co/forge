import { ANSWER_VIEWS } from '@forge/contracts/projection';
import { WORKFLOW_STEP_ID } from '@forge/contracts/workflow-health';
import { DESIGN_VIEWS } from '@forge/contracts/workflows';
import { type Context, Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import { egressForRequest } from '../lib/data-egress.js';
import { type AuthVars, assertEmailVerified, requireAuth } from '../middleware/auth.js';
import { strictBody, zValidator } from '../middleware/zod-validator.js';
import { refused } from '../lib/refusal.js';
import { envelopeOf } from '../lib/write-envelope.js';
import { DESIGN_DECISIONS, DESIGN_REASON_MAX } from './design.js';
import {
  type DesignOutcome,
  decideDesignAs,
  linkBuildAs,
  proposeDesign,
  readDesignAs,
  unlinkBuildAs,
} from './design-service.js';
import { WRITE_OBSERVATION_SHAPE, writeObservationSchema } from './observation-schema.js';
import { listObservations, observationAs, writeObservation } from './observations.js';
import { designStepsOf, designSummaryOf, workflowSummaryOf } from './projection.js';
import {
  createWorkflow,
  listWorkflowsAs,
  readWorkflowAs,
  updateWorkflow,
  type WorkflowOutcome,
  type WorkflowWriter,
  workflowView,
} from './service.js';
import { readSystemGraphAs } from './system-graph-read.js';
import { listProjectTemplatesAs, readProjectTemplateAs } from './template-service.js';
import { requireCan } from '../permissions/index.js';

export const workflowRoutes = new Hono<{ Variables: AuthVars }>();

for (const path of [
  '/:id/workflows',
  '/:id/workflows/*',
  '/:id/workflow-templates',
  '/:id/workflow-templates/*',
]) {
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

const listView = zValidator(
  'query',
  z.strictObject({ view: z.enum(ANSWER_VIEWS).optional() }),
  (r) => {
    if (!r.success) throw badRequest('invalid query: view? (summary | full, full by default)');
  },
);

const designView = zValidator(
  'query',
  z.strictObject({
    view: z.enum(DESIGN_VIEWS).optional(),
    revision: z.coerce.number().int().min(1).optional(),
    stepFrom: z.coerce.number().int().min(1).optional(),
    stepTo: z.coerce.number().int().min(1).optional(),
  }),
  (r) => {
    if (!r.success) {
      throw badRequest(
        'invalid query: view? (summary | steps | full, full by default), and with view=steps revision?, stepFrom?, stepTo? (whole numbers from 1)',
      );
    }
  },
);

function writerOf(c: Context<{ Variables: AuthVars }>): WorkflowWriter {
  const agency = c.get('agency');
  if (!agency) throw new Error('workflows: a write reached its handler without an auth gate');
  return { userId: c.get('userId'), agency };
}

function answer(c: Context, outcome: WorkflowOutcome) {
  if (!outcome.ok) return refused(c, outcome.refusals, 'WORKFLOW_REFUSED');
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

workflowRoutes.get('/:id/workflows', idParam, listView, async (c) => {
  const { id } = c.req.valid('param');
  const listed = await egressForRequest(
    c.get('agency'),
    id,
    'design',
    await listWorkflowsAs(c.get('userId'), id),
    'the workflows',
  );
  const workflows =
    c.req.valid('query').view === 'summary' ? listed.map(workflowSummaryOf) : listed;
  return c.json({ workflows, returned: workflows.length });
});

workflowRoutes.get('/:id/workflows/:workflow', workflowParam, async (c) => {
  const { id, workflow } = c.req.valid('param');
  return c.json(
    await egressForRequest(
      c.get('agency'),
      id,
      'design',
      await readWorkflowAs(c.get('userId'), id, workflow),
      `workflow ${workflow}`,
    ),
  );
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

function answerDesign(c: Context, outcome: DesignOutcome) {
  if (!outcome.ok) return refused(c, outcome.refusals, 'WORKFLOW_REFUSED');
  return c.json(outcome.design);
}

workflowRoutes.get('/:id/workflows/:workflow/design', workflowParam, designView, async (c) => {
  const { id, workflow } = c.req.valid('param');
  const q = c.req.valid('query');
  if (
    q.view !== 'steps' &&
    (q.revision !== undefined || q.stepFrom !== undefined || q.stepTo !== undefined)
  ) {
    throw badRequest(
      'invalid query: revision, stepFrom and stepTo bound view=steps; send view=steps with them',
    );
  }
  const design = await egressForRequest(
    c.get('agency'),
    id,
    'design',
    await readDesignAs(writerOf(c), id, workflow),
    `workflow ${workflow}`,
  );
  if (q.view === 'summary') return c.json(designSummaryOf(design));
  if (q.view === 'steps') {
    return c.json(designStepsOf(design, { revision: q.revision, from: q.stepFrom, to: q.stepTo }));
  }
  return c.json(design);
});

const graphQuery = zValidator(
  'query',
  z.strictObject({
    revision: z.coerce.number().int().min(1).optional(),
    against: z.coerce.number().int().min(1).optional(),
  }),
  (r) => {
    if (!r.success) {
      throw badRequest(
        'invalid query: revision? (the revision to read, the current one by default) and against? (a revision whose removed steps are drawn too), whole numbers from 1',
      );
    }
  },
);

workflowRoutes.get(
  '/:id/workflows/:workflow/system-graph',
  workflowParam,
  graphQuery,
  async (c) => {
    const { id, workflow } = c.req.valid('param');
    const outcome = await readSystemGraphAs({
      userId: c.get('userId'),
      projectId: id,
      workflowId: workflow,
      ...c.req.valid('query'),
    });
    if (!outcome.ok) return refused(c, outcome.refusals, 'WORKFLOW_REFUSED');
    return c.json(
      await egressForRequest(c.get('agency'), id, 'design', outcome.graph, `workflow ${workflow}`),
    );
  },
);

workflowRoutes.post(
  '/:id/workflows/:workflow/design/propose',
  workflowParam,
  strictBody(
    z.strictObject({
      revision: z.number().int().min(1),
      issue: z.string().trim().min(1).max(200).optional(),
    }),
    '{ revision, issue? } names the workflow revision being proposed and the issue it is drawn under',
  ),
  async (c) => {
    const { id, workflow } = c.req.valid('param');
    const { revision, issue } = c.req.valid('json');
    return answerDesign(
      c,
      await proposeDesign({ projectId: id, id: workflow, writer: writerOf(c), revision, issue }),
    );
  },
);

workflowRoutes.post(
  '/:id/workflows/:workflow/design/decision',
  workflowParam,
  strictBody(
    z.strictObject({
      revision: z.number().int().min(1),
      decision: z.enum(DESIGN_DECISIONS),
      reason: z.string().max(DESIGN_REASON_MAX).nullable().optional(),
    }),
    `{ revision, decision: ${DESIGN_DECISIONS.join(' | ')}, reason } — a return carries its reason`,
  ),
  async (c) => {
    const { id, workflow } = c.req.valid('param');
    const body = c.req.valid('json');
    return answerDesign(
      c,
      await decideDesignAs({
        projectId: id,
        id: workflow,
        decider: writerOf(c),
        revision: body.revision,
        decision: body.decision,
        reason: body.reason ?? null,
      }),
    );
  },
);

workflowRoutes.post(
  '/:id/workflows/:workflow/builds',
  workflowParam,
  strictBody(
    z.strictObject({
      issue: z.string().trim().min(1).max(200),
      steps: z.array(z.string().regex(WORKFLOW_STEP_ID)).max(40).optional(),
    }),
    '{ issue, steps? } names the issue that builds this workflow, by uuid or key, and the steps it builds when its criteria trace none',
  ),
  async (c) => {
    const { id, workflow } = c.req.valid('param');
    const body = c.req.valid('json');
    return answerDesign(
      c,
      await linkBuildAs({
        projectId: id,
        id: workflow,
        actor: writerOf(c),
        issue: body.issue,
        steps: body.steps,
      }),
    );
  },
);

workflowRoutes.delete('/:id/workflows/:workflow/builds/:issue', async (c) => {
  const id = z.uuid().safeParse(c.req.param('id'));
  const workflow = z.uuid().safeParse(c.req.param('workflow'));
  if (!id.success || !workflow.success) {
    throw badRequest('invalid path: the project and the workflow are uuids');
  }
  return answerDesign(
    c,
    await unlinkBuildAs({
      projectId: id.data,
      id: workflow.data,
      actor: writerOf(c),
      issue: c.req.param('issue'),
    }),
  );
});

workflowRoutes.get('/:id/workflow-templates', idParam, async (c) => {
  const templates = await listProjectTemplatesAs(c.get('userId'), c.req.valid('param').id);
  return c.json({ templates, returned: templates.length });
});

workflowRoutes.get('/:id/workflow-templates/:templateId/:version', async (c) => {
  const id = z.uuid().safeParse(c.req.param('id'));
  if (!id.success) throw badRequest('invalid path: the project id is a uuid');
  return c.json(
    await readProjectTemplateAs(
      c.get('userId'),
      id.data,
      c.req.param('templateId'),
      c.req.param('version'),
    ),
  );
});

const workflowRefParam = zValidator(
  'param',
  z.object({ id: z.uuid(), workflow: z.string().trim().min(1).max(200) }),
  (r) => {
    if (!r.success) throw badRequest('invalid path: a project uuid and a workflow uuid or flow');
  },
);

workflowRoutes.post(
  '/:id/workflows/:workflow/observations',
  workflowRefParam,
  strictBody(writeObservationSchema, WRITE_OBSERVATION_SHAPE),
  async (c) => {
    const { id, workflow } = c.req.valid('param');
    const outcome = await writeObservation({
      projectId: id,
      workflow,
      writer: writerOf(c),
      write: c.req.valid('json'),
    });
    if (!outcome.ok) return refused(c, outcome.refusals, 'WORKFLOW_REFUSED');
    return c.json({ observation: outcome.observation }, outcome.created ? 201 : 200);
  },
);

workflowRoutes.get('/:id/workflows/:workflow/observations', workflowRefParam, async (c) => {
  const { id, workflow } = c.req.valid('param');
  await requireCan({ userId: c.get('userId') }, 'project.read', id);
  return c.json(await listObservations(id, workflow));
});

workflowRoutes.get(
  '/:id/workflows/:workflow/observations/:at',
  zValidator(
    'param',
    z.object({
      id: z.uuid(),
      workflow: z.string().trim().min(1).max(200),
      at: z.string().trim().min(1).max(64),
    }),
    (r) => {
      if (!r.success)
        throw badRequest(
          'invalid path: a project uuid, a workflow uuid or flow, and latest, a commit sha or an observation id',
        );
    },
  ),
  async (c) => {
    const { id, workflow, at } = c.req.valid('param');
    await requireCan({ userId: c.get('userId') }, 'project.read', id);
    return c.json({
      observation: await egressForRequest(
        c.get('agency'),
        id,
        'design',
        await observationAs(id, workflow, at),
        `workflow ${workflow} observation ${at}`,
      ),
    });
  },
);
