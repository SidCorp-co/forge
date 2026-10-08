import {
  type CommentScope,
  CREATE_ENTITY_COMMENT_SHAPE,
  createEntityCommentRequestSchema,
  EDIT_ENTITY_COMMENT_SHAPE,
  type EntityCommentResponse,
  type EntityCommentScope,
  editEntityCommentRequestSchema,
} from '@forge/contracts/comments';
import { COMMENT_INTENTS } from '@forge/contracts/record-events';
import { type Context, Hono } from 'hono';
import { z } from 'zod';
import { refused } from '../lib/refusal.js';
import { type AuthVars, assertEmailVerified, requireAuth } from '../middleware/auth.js';
import { holdChatWrite } from '../middleware/chat-write-hold.js';
import { invalid, strictBody, zValidator } from '../middleware/zod-validator.js';
import { type EntityCommentActor, listEntityCommentsAs } from './entity-read.js';
import {
  type EntityCommentOutcome,
  editEntityComment,
  postEntityComment,
} from './entity-service.js';

export const entityCommentRoutes = new Hono<{ Variables: AuthVars }>();

// the three target paths sit under /:id/requirements/*, /:id/workflows/* and /:id/feedback/*,
// which their own modules already gate; gating them again here would run the PAT admission twice.
// An issue's decisions path is gated here: the issue module's gate is mounted after this one
entityCommentRoutes.use('/:id/issues/:issue/comments', requireAuth(), assertEmailVerified());

type Target<S extends CommentScope = EntityCommentScope> = {
  scope: S;
  param: string;
  names: string;
};

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
const ISSUE: Target<'issue'> = {
  scope: 'issue',
  param: 'issue',
  names: 'an issue uuid or key (ISS-n)',
};

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
  invalid(`invalid query: intent? (${COMMENT_INTENTS.join(' | ')})`),
);

const ref = z.string().trim().min(1).max(200);

function targetParam(t: Target<CommentScope>) {
  return zValidator(
    'param',
    z.object({ id: z.uuid(), [t.param]: ref }),
    invalid(`invalid path: a project uuid and ${t.names}`),
  );
}

function commentParam(t: Target) {
  return zValidator(
    'param',
    z.object({ id: z.uuid(), [t.param]: ref, comment: z.uuid() }),
    invalid(`invalid path: a project uuid, ${t.names} and a comment uuid`),
  );
}

type Params = Record<string, string>;

async function listFor(
  c: Context<{ Variables: AuthVars }>,
  t: Target<CommentScope>,
  params: Params,
  intent: (typeof COMMENT_INTENTS)[number] | undefined,
) {
  return c.json(
    await listEntityCommentsAs(
      actorOf(c),
      params.id as string,
      t.scope,
      params[t.param] as string,
      {
        intent,
      },
    ),
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
entityCommentRoutes.post(
  '/:id/requirements/:req/comments',
  targetParam(REQUIREMENT),
  createBody,
  holdChatWrite('comment'),
  (c) => postFor(c, REQUIREMENT, c.req.valid('param') as Params, c.req.valid('json')),
);
entityCommentRoutes.patch(
  '/:id/requirements/:req/comments/:comment',
  commentParam(REQUIREMENT),
  editBody,
  (c) => editFor(c, REQUIREMENT, c.req.valid('param') as Params, c.req.valid('json')),
);

entityCommentRoutes.get(
  '/:id/workflows/:workflow/comments',
  targetParam(WORKFLOW),
  intentQuery,
  (c) => listFor(c, WORKFLOW, c.req.valid('param') as Params, c.req.valid('query').intent),
);
entityCommentRoutes.post(
  '/:id/workflows/:workflow/comments',
  targetParam(WORKFLOW),
  createBody,
  holdChatWrite('comment'),
  (c) => postFor(c, WORKFLOW, c.req.valid('param') as Params, c.req.valid('json')),
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
entityCommentRoutes.post(
  '/:id/feedback/:fb/comments',
  targetParam(FEEDBACK),
  createBody,
  holdChatWrite('comment'),
  (c) => postFor(c, FEEDBACK, c.req.valid('param') as Params, c.req.valid('json')),
);
entityCommentRoutes.patch(
  '/:id/feedback/:fb/comments/:comment',
  commentParam(FEEDBACK),
  editBody,
  (c) => editFor(c, FEEDBACK, c.req.valid('param') as Params, c.req.valid('json')),
);

// REQ-33 BC-2: an issue's decisions, read as a requirement's and a workflow's are. Its thread is
// read at /api/issues/:id/comments and written there, so this path lists decisions and nothing else.
entityCommentRoutes.get(
  '/:id/issues/:issue/comments',
  targetParam(ISSUE),
  zValidator(
    'query',
    z.strictObject({ intent: z.literal('decision') }),
    invalid(
      "invalid query: intent=decision — an issue's thread is read at /api/issues/:id/comments",
    ),
  ),
  (c) => listFor(c, ISSUE, c.req.valid('param') as Params, c.req.valid('query').intent),
);
