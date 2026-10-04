import {
  COMMENT_SCOPES,
  CREATE_ENTITY_COMMENT_SHAPE,
  createEntityCommentRequestSchema,
  EDIT_ENTITY_COMMENT_SHAPE,
  type EntityCommentResponse,
  type EntityCommentScope,
  editEntityCommentRequestSchema,
  listDecisionsQuerySchema,
} from '@forge/contracts/comments';
import { COMMENT_INTENTS } from '@forge/contracts/record-events';
import { type Context, Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import { refused } from '../lib/refusal.js';
import { type AuthVars, assertEmailVerified, requireAuth } from '../middleware/auth.js';
import { strictBody, zValidator } from '../middleware/zod-validator.js';
import { type EntityCommentActor, listDecisionsAs, listEntityCommentsAs } from './entity-read.js';
import {
  type EntityCommentOutcome,
  editEntityComment,
  postEntityComment,
} from './entity-service.js';

export const entityCommentRoutes = new Hono<{ Variables: AuthVars }>();

// cm:why the three target paths sit under /:id/requirements/*, /:id/workflows/* and /:id/feedback/*,
// which their own modules already gate; gating them again here would run the PAT admission twice
entityCommentRoutes.use('/:id/decisions', requireAuth(), assertEmailVerified());

const badRequest = (message: string) =>
  new HTTPException(400, { message, cause: { code: 'BAD_REQUEST' } });

type Target = { scope: EntityCommentScope; param: string; names: string };

const REQUIREMENT: Target = {
  scope: 'requirement',
  param: 'req',
  names: 'a requirement uuid or key (REQ-n)',
};
const WORKFLOW: Target = {
  scope: 'workflow',
  param: 'workflow',
  names: 'a workflow uuid or its flow name',
};
const FEEDBACK: Target = { scope: 'feedback', param: 'fb', names: 'a feedback uuid or key (FB-n)' };

function actorOf(c: Context<{ Variables: AuthVars }>): EntityCommentActor {
  const agency = c.get('agency');
  if (!agency) throw new Error('comments: a request reached its handler without an auth gate');
  return { userId: c.get('userId'), agency };
}

function answer(c: Context, outcome: EntityCommentOutcome) {
  if (!outcome.ok) return refused(c, outcome.refusals, 'COMMENT_REFUSED');
  const body: EntityCommentResponse = { comment: outcome.comment };
  return c.json(body, outcome.created ? 201 : 200);
}

const intentQuery = zValidator(
  'query',
  z.strictObject({ intent: z.enum(COMMENT_INTENTS).optional() }),
  (r) => {
    if (!r.success) throw badRequest(`invalid query: intent? (${COMMENT_INTENTS.join(' | ')})`);
  },
);

const ref = z.string().trim().min(1).max(200);

function targetParam(t: Target) {
  return zValidator('param', z.object({ id: z.uuid(), [t.param]: ref }), (r) => {
    if (!r.success) throw badRequest(`invalid path: a project uuid and ${t.names}`);
  });
}

function commentParam(t: Target) {
  return zValidator('param', z.object({ id: z.uuid(), [t.param]: ref, comment: z.uuid() }), (r) => {
    if (!r.success) throw badRequest(`invalid path: a project uuid, ${t.names} and a comment uuid`);
  });
}

type Params = Record<string, string>;

async function listFor(
  c: Context<{ Variables: AuthVars }>,
  t: Target,
  params: Params,
  intent: (typeof COMMENT_INTENTS)[number] | undefined,
) {
  return c.json(
    await listEntityCommentsAs(actorOf(c), params.id as string, t.scope, params[t.param] as string, {
      intent,
    }),
  );
}

async function postFor(
  c: Context<{ Variables: AuthVars }>,
  t: Target,
  params: Params,
  request: Parameters<typeof postEntityComment>[0]['request'],
) {
  return answer(
    c,
    await postEntityComment({
      projectId: params.id as string,
      scope: t.scope,
      ref: params[t.param] as string,
      author: { ...actorOf(c), deviceId: c.get('patDeviceId') ?? null },
      request,
    }),
  );
}

async function editFor(
  c: Context<{ Variables: AuthVars }>,
  t: Target,
  params: Params,
  request: Parameters<typeof editEntityComment>[0]['request'],
) {
  return answer(
    c,
    await editEntityComment({
      projectId: params.id as string,
      scope: t.scope,
      ref: params[t.param] as string,
      commentId: params.comment as string,
      actor: actorOf(c),
      request,
    }),
  );
}

const createBody = strictBody(createEntityCommentRequestSchema, CREATE_ENTITY_COMMENT_SHAPE);
const editBody = strictBody(editEntityCommentRequestSchema, EDIT_ENTITY_COMMENT_SHAPE);

entityCommentRoutes.get(
  '/:id/requirements/:req/comments',
  targetParam(REQUIREMENT),
  intentQuery,
  (c) => listFor(c, REQUIREMENT, c.req.valid('param') as Params, c.req.valid('query').intent),
);
entityCommentRoutes.post('/:id/requirements/:req/comments', targetParam(REQUIREMENT), createBody, (c) =>
  postFor(c, REQUIREMENT, c.req.valid('param') as Params, c.req.valid('json')),
);
entityCommentRoutes.patch(
  '/:id/requirements/:req/comments/:comment',
  commentParam(REQUIREMENT),
  editBody,
  (c) => editFor(c, REQUIREMENT, c.req.valid('param') as Params, c.req.valid('json')),
);

entityCommentRoutes.get('/:id/workflows/:workflow/comments', targetParam(WORKFLOW), intentQuery, (c) =>
  listFor(c, WORKFLOW, c.req.valid('param') as Params, c.req.valid('query').intent),
);
entityCommentRoutes.post('/:id/workflows/:workflow/comments', targetParam(WORKFLOW), createBody, (c) =>
  postFor(c, WORKFLOW, c.req.valid('param') as Params, c.req.valid('json')),
);
entityCommentRoutes.patch(
  '/:id/workflows/:workflow/comments/:comment',
  commentParam(WORKFLOW),
  editBody,
  (c) => editFor(c, WORKFLOW, c.req.valid('param') as Params, c.req.valid('json')),
);

entityCommentRoutes.get('/:id/feedback/:fb/comments', targetParam(FEEDBACK), intentQuery, (c) =>
  listFor(c, FEEDBACK, c.req.valid('param') as Params, c.req.valid('query').intent),
);
entityCommentRoutes.post('/:id/feedback/:fb/comments', targetParam(FEEDBACK), createBody, (c) =>
  postFor(c, FEEDBACK, c.req.valid('param') as Params, c.req.valid('json')),
);
entityCommentRoutes.patch(
  '/:id/feedback/:fb/comments/:comment',
  commentParam(FEEDBACK),
  editBody,
  (c) => editFor(c, FEEDBACK, c.req.valid('param') as Params, c.req.valid('json')),
);

entityCommentRoutes.get(
  '/:id/decisions',
  zValidator('param', z.object({ id: z.uuid() }), (r) => {
    if (!r.success) throw badRequest('invalid path: the project id is a uuid');
  }),
  zValidator('query', listDecisionsQuerySchema, (r) => {
    if (!r.success) {
      throw badRequest(`invalid query: scope? (${COMMENT_SCOPES.join(' | ')}), limit? (1..200)`);
    }
  }),
  async (c) =>
    c.json(await listDecisionsAs(actorOf(c), c.req.valid('param').id, c.req.valid('query'))),
);
