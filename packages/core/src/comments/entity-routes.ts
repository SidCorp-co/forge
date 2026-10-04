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
import { type Context, Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import { COMMENT_INTENTS } from '@forge/contracts/record-events';
import { type AuthVars, assertEmailVerified, requireAuth } from '../middleware/auth.js';
import { strictBody, zValidator } from '../middleware/zod-validator.js';
import { refused } from '../lib/refusal.js';
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

const TARGETS: { scope: EntityCommentScope; segment: string; param: string; names: string }[] = [
  {
    scope: 'requirement',
    segment: 'requirements',
    param: 'req',
    names: 'a requirement uuid or key (REQ-n)',
  },
  {
    scope: 'workflow',
    segment: 'workflows',
    param: 'workflow',
    names: 'a workflow uuid or its flow name',
  },
  { scope: 'feedback', segment: 'feedback', param: 'fb', names: 'a feedback uuid or key (FB-n)' },
];

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

for (const t of TARGETS) {
  const ref = z.string().trim().min(1).max(200);
  const targetParam = zValidator('param', z.object({ id: z.uuid(), [t.param]: ref }), (r) => {
    if (!r.success) throw badRequest(`invalid path: a project uuid and ${t.names}`);
  });
  const commentParam = zValidator(
    'param',
    z.object({ id: z.uuid(), [t.param]: ref, comment: z.uuid() }),
    (r) => {
      if (!r.success)
        throw badRequest(`invalid path: a project uuid, ${t.names} and a comment uuid`);
    },
  );
  const refOf = (params: Record<string, string>) => params[t.param] as string;
  const path = `/:id/${t.segment}/:${t.param}/comments`;

  entityCommentRoutes.get(path, targetParam, intentQuery, async (c) => {
    const params = c.req.valid('param') as Record<string, string>;
    const { intent } = c.req.valid('query');
    return c.json(
      await listEntityCommentsAs(actorOf(c), params.id as string, t.scope, refOf(params), {
        intent,
      }),
    );
  });

  entityCommentRoutes.post(
    path,
    targetParam,
    strictBody(createEntityCommentRequestSchema, CREATE_ENTITY_COMMENT_SHAPE),
    async (c) => {
      const params = c.req.valid('param') as Record<string, string>;
      return answer(
        c,
        await postEntityComment({
          projectId: params.id as string,
          scope: t.scope,
          ref: refOf(params),
          author: { ...actorOf(c), deviceId: c.get('patDeviceId') ?? null },
          request: c.req.valid('json'),
        }),
      );
    },
  );

  entityCommentRoutes.patch(
    `${path}/:comment`,
    commentParam,
    strictBody(editEntityCommentRequestSchema, EDIT_ENTITY_COMMENT_SHAPE),
    async (c) => {
      const params = c.req.valid('param') as Record<string, string>;
      return answer(
        c,
        await editEntityComment({
          projectId: params.id as string,
          scope: t.scope,
          ref: refOf(params),
          commentId: params.comment as string,
          actor: actorOf(c),
          request: c.req.valid('json'),
        }),
      );
    },
  );
}

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
