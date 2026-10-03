import { type Context, Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import { SUGGESTION_KINDS, SUGGESTION_STATUSES } from '../db/schema-suggestions.js';
import { type AuthVars, assertEmailVerified, requireAuth } from '../middleware/auth.js';
import { strictBody, zValidator } from '../middleware/zod-validator.js';
import { answerRefusal } from '../lib/refusal.js';
import {
  acceptSuggestion,
  createSuggestion,
  listSuggestions,
  rejectSuggestion,
  type SuggestionActor,
  type SuggestionOutcome,
  type SuggestionTargetRef,
  withdrawSuggestion,
} from './service.js';

export const suggestionRoutes = new Hono<{ Variables: AuthVars }>();

for (const path of ['/:id/suggestions', '/:id/suggestions/*']) {
  suggestionRoutes.use(path, requireAuth(), assertEmailVerified());
}

const badRequest = (message: string) =>
  new HTTPException(400, { message, cause: { code: 'BAD_REQUEST' } });

const projectParam = zValidator('param', z.object({ id: z.uuid() }), (r) => {
  if (!r.success) throw badRequest('invalid path: the project id is a uuid');
});

const suggestionParam = zValidator('param', z.object({ id: z.uuid(), sid: z.uuid() }), (r) => {
  if (!r.success) throw badRequest('invalid path: a project uuid and a suggestion uuid');
});

function actorOf(c: Context<{ Variables: AuthVars }>): SuggestionActor {
  const agency = c.get('agency');
  if (!agency) throw new Error('suggestions: a request reached its handler without an auth gate');
  return { userId: c.get('userId'), agency };
}

export function answerSuggestion(c: Context, outcome: SuggestionOutcome) {
  if (!outcome.ok)
    return answerRefusal(c, outcome.refusals, { fallbackCode: 'SUGGESTION_REFUSED' });
  return c.json(
    { suggestion: outcome.suggestion, ...(outcome.effect ? { effect: outcome.effect } : {}) },
    outcome.created ? 201 : 200,
  );
}

const targetFields = {
  requirement: z.string().trim().min(1).max(64).optional(),
  issue: z.string().trim().min(1).max(200).optional(),
};

function targetOf(v: { requirement?: string | undefined; issue?: string | undefined }) {
  if (v.requirement && v.issue) throw badRequest('name one target: `requirement` or `issue`');
  if (v.requirement) return { requirement: v.requirement } satisfies SuggestionTargetRef;
  if (v.issue) return { issue: v.issue } satisfies SuggestionTargetRef;
  return undefined;
}

suggestionRoutes.get(
  '/:id/suggestions',
  projectParam,
  zValidator(
    'query',
    z.strictObject({
      ...targetFields,
      status: z
        .string()
        .optional()
        .transform((s) => (s ? s.split(',') : undefined))
        .pipe(z.array(z.enum(SUGGESTION_STATUSES)).optional()),
    }),
    (r) => {
      if (!r.success)
        throw badRequest(
          `invalid query: requirement?, issue?, status? (comma-separated: ${SUGGESTION_STATUSES.join(', ')})`,
        );
    },
  ),
  async (c) => {
    const q = c.req.valid('query');
    return c.json(
      await listSuggestions({
        projectId: c.req.valid('param').id,
        userId: c.get('userId'),
        target: targetOf(q),
        statuses: q.status,
      }),
    );
  },
);

suggestionRoutes.post(
  '/:id/suggestions',
  projectParam,
  strictBody(
    z.strictObject({
      kind: z.enum(SUGGESTION_KINDS),
      ...targetFields,
      baseRevision: z.number().int().min(1).nullable(),
      payload: z.unknown(),
      model: z.string().max(200).nullable().optional(),
    }),
    `{ kind: ${SUGGESTION_KINDS.join(' | ')}, requirement | issue, baseRevision, payload, model? }`,
  ),
  async (c) => {
    const body = c.req.valid('json');
    const target = targetOf(body);
    if (!target) throw badRequest('a suggestion names its target: `requirement` or `issue`');
    const actor = actorOf(c);
    return answerSuggestion(
      c,
      await createSuggestion({
        projectId: c.req.valid('param').id,
        actor,
        producerKind: actor.agency === 'agent' ? 'agent' : 'person',
        producerId: actor.userId,
        kind: body.kind,
        target,
        baseRevision: body.baseRevision,
        payload: body.payload,
        model: body.model ?? null,
      }),
    );
  },
);

const emptyBody = strictBody(z.strictObject({}), 'this action takes an empty object');

suggestionRoutes.post('/:id/suggestions/:sid/accept', suggestionParam, emptyBody, async (c) => {
  const { id, sid } = c.req.valid('param');
  return answerSuggestion(c, await acceptSuggestion({ projectId: id, id: sid, actor: actorOf(c) }));
});

suggestionRoutes.post(
  '/:id/suggestions/:sid/reject',
  suggestionParam,
  strictBody(z.strictObject({ reason: z.string().max(4_000) }), '{ reason } says why'),
  async (c) => {
    const { id, sid } = c.req.valid('param');
    return answerSuggestion(
      c,
      await rejectSuggestion({
        projectId: id,
        id: sid,
        actor: actorOf(c),
        reason: c.req.valid('json').reason,
      }),
    );
  },
);

suggestionRoutes.post('/:id/suggestions/:sid/withdraw', suggestionParam, emptyBody, async (c) => {
  const { id, sid } = c.req.valid('param');
  return answerSuggestion(
    c,
    await withdrawSuggestion({ projectId: id, id: sid, actor: actorOf(c) }),
  );
});
