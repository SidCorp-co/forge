import {
  ACCEPT_SUGGESTION_SHAPE,
  acceptSuggestionRequestSchema,
  CREATE_SUGGESTION_SHAPE,
  createSuggestionRequestSchema,
  listSuggestionsQuerySchema,
  REVISE_SUGGESTION_SHAPE,
  rejectSuggestionRequestSchema,
  reviseSuggestionRequestSchema,
  SUGGESTION_STATUSES,
  type SuggestionResponse,
  suggestionSummaryOf,
} from '@forge/contracts/suggestions';
import { type Context, Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import { refused } from '../lib/refusal.js';
import { type AuthVars, assertEmailVerified, requireAuth } from '../middleware/auth.js';
import { invalid, strictBody, zValidator } from '../middleware/zod-validator.js';
import { listSuggestions } from './list.js';
import type { SuggestionActor, SuggestionTargetRef } from './read.js';
import {
  acceptSuggestion,
  createSuggestion,
  rejectSuggestion,
  reviseSuggestion,
  type SuggestionOutcome,
  withdrawSuggestion,
} from './service.js';

export const suggestionRoutes = new Hono<{ Variables: AuthVars }>();

for (const path of ['/:id/suggestions', '/:id/suggestions/*']) {
  suggestionRoutes.use(path, requireAuth(), assertEmailVerified());
}

const badRequest = (message: string) =>
  new HTTPException(400, { message, cause: { code: 'BAD_REQUEST' } });

const projectParam = zValidator(
  'param',
  z.object({ id: z.uuid() }),
  invalid('invalid path: the project id is a uuid'),
);

const suggestionParam = zValidator(
  'param',
  z.object({ id: z.uuid(), sid: z.uuid() }),
  invalid('invalid path: a project uuid and a suggestion uuid'),
);

function actorOf(c: Context<{ Variables: AuthVars }>): SuggestionActor {
  const agency = c.get('agency');
  if (!agency) throw new Error('suggestions: a request reached its handler without an auth gate');
  return { userId: c.get('userId'), agency, deviceId: c.get('patDeviceId') ?? null };
}

function answer(c: Context, outcome: SuggestionOutcome) {
  if (!outcome.ok) return refused(c, outcome.refusals, 'SUGGESTION_REFUSED');
  const body: SuggestionResponse = {
    suggestion: outcome.suggestion,
    ...(outcome.effect ? { effect: outcome.effect } : {}),
    ...(outcome.acceptRefused ? { acceptRefused: outcome.acceptRefused } : {}),
  };
  return c.json(body, outcome.created ? 201 : 200);
}

function targetOf(v: {
  requirement?: string | undefined;
  issue?: string | undefined;
  feedback?: string | undefined;
  workflow?: string | undefined;
}): SuggestionTargetRef | undefined {
  if ([v.requirement, v.issue, v.feedback, v.workflow].filter(Boolean).length > 1) {
    throw badRequest('name one target: `requirement`, `issue`, `feedback` or `workflow`');
  }
  if (v.workflow) return { workflow: v.workflow };
  if (v.requirement) return { requirement: v.requirement };
  if (v.issue) return { issue: v.issue };
  if (v.feedback) return { feedback: v.feedback };
  return undefined;
}

suggestionRoutes.get(
  '/:id/suggestions',
  projectParam,
  zValidator(
    'query',
    listSuggestionsQuerySchema,
    invalid(
      `invalid query: requirement?, issue?, feedback?, workflow?, status? (comma-separated: ${SUGGESTION_STATUSES.join(', ')}), view? (summary | full, full by default)`,
    ),
  ),
  async (c) => {
    const q = c.req.valid('query');
    const listed = await listSuggestions({
      projectId: c.req.valid('param').id,
      userId: c.get('userId'),
      target: targetOf(q),
      statuses: q.status,
    });
    if (q.view !== 'summary') return c.json(listed);
    return c.json({ ...listed, suggestions: listed.suggestions.map(suggestionSummaryOf) });
  },
);

suggestionRoutes.post(
  '/:id/suggestions',
  projectParam,
  strictBody(createSuggestionRequestSchema, CREATE_SUGGESTION_SHAPE),
  async (c) => {
    const body = c.req.valid('json');
    const target = targetOf(body);
    if (!target) throw badRequest(`invalid body: ${CREATE_SUGGESTION_SHAPE}`);
    const actor = actorOf(c);
    return answer(
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

suggestionRoutes.post(
  '/:id/suggestions/:sid/accept',
  suggestionParam,
  strictBody(acceptSuggestionRequestSchema, ACCEPT_SUGGESTION_SHAPE),
  async (c) => {
    const { id, sid } = c.req.valid('param');
    return answer(
      c,
      await acceptSuggestion({
        projectId: id,
        id: sid,
        actor: actorOf(c),
        reason: c.req.valid('json').reason,
      }),
    );
  },
);

suggestionRoutes.post(
  '/:id/suggestions/:sid/reject',
  suggestionParam,
  strictBody(rejectSuggestionRequestSchema, '{ reason } says why'),
  async (c) => {
    const { id, sid } = c.req.valid('param');
    return answer(
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

suggestionRoutes.post(
  '/:id/suggestions/:sid/revise',
  suggestionParam,
  strictBody(reviseSuggestionRequestSchema, REVISE_SUGGESTION_SHAPE),
  async (c) => {
    const { id, sid } = c.req.valid('param');
    const body = c.req.valid('json');
    return answer(
      c,
      await reviseSuggestion({
        projectId: id,
        id: sid,
        actor: actorOf(c),
        payload: body.payload,
        reason: body.reason,
      }),
    );
  },
);

suggestionRoutes.post('/:id/suggestions/:sid/withdraw', suggestionParam, emptyBody, async (c) => {
  const { id, sid } = c.req.valid('param');
  return answer(c, await withdrawSuggestion({ projectId: id, id: sid, actor: actorOf(c) }));
});
