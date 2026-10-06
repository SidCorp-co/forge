import {
  MARK_DONE_SHAPE,
  markDoneRequestSchema,
  type OnboardingResponse,
  type OnboardingStateResponse,
  POST_QUESTIONNAIRE_SHAPE,
  POST_UPDATE_SHAPE,
  postQuestionnaireRequestSchema,
  postUpdateRequestSchema,
  type QuestionnaireResponse,
  REANALYZE_SHAPE,
  reanalyzeRequestSchema,
  START_SHAPE,
  startRequestSchema,
} from '@forge/contracts/onboarding';
import { type Context, Hono } from 'hono';
import { z } from 'zod';
import { type Refusal, refused } from '../lib/refusal.js';
import { type AuthVars, assertEmailVerified, requireAuth } from '../middleware/auth.js';
import { invalid, strictBody, zValidator } from '../middleware/zod-validator.js';
import type { OnboardingActor, OnboardingOutcome } from './act.js';
import {
  markOnboardingDone,
  postOnboardingQuestionnaire,
  postOnboardingUpdate,
} from './agent-writes.js';
import { readFirstRequirements } from './first-requirements.js';
import { readOnboardingState } from './read.js';
import { joinOnboarding, readAnswers, reanalyzeOnboarding, startOnboarding } from './service.js';

export const onboardingRoutes = new Hono<{ Variables: AuthVars }>();

for (const path of ['/:id/onboarding', '/:id/onboarding/*']) {
  onboardingRoutes.use(path, requireAuth(), assertEmailVerified());
}

const projectParam = zValidator(
  'param',
  z.object({ id: z.uuid() }),
  invalid('invalid path: the project id is a uuid'),
);

function actorOf(c: Context<{ Variables: AuthVars }>): OnboardingActor {
  const agency = c.get('agency');
  if (!agency) throw new Error('onboarding: a request reached its handler without an auth gate');
  return { userId: c.get('userId'), agency };
}

/** The one envelope, `ONBOARDING_REFUSED` when the codes differ. */
function refusedOnboarding(c: Context, refusals: readonly Refusal[]) {
  return refused(c, refusals, 'ONBOARDING_REFUSED');
}

function answer(c: Context, outcome: OnboardingOutcome) {
  if (!outcome.ok) return refusedOnboarding(c, outcome.refusals);
  const body: OnboardingResponse = { onboarding: outcome.onboarding };
  return c.json(body, outcome.created ? 201 : 200);
}

const emptyBody = strictBody(z.strictObject({}), 'this action takes an empty object');

onboardingRoutes.get('/:id/onboarding', projectParam, async (c) => {
  const { id } = c.req.valid('param');
  const state = await readOnboardingState(id, c.get('userId'));
  const body: OnboardingStateResponse = {
    ...state,
    firstRequirements: await readFirstRequirements(id),
  };
  return c.json(body);
});

onboardingRoutes.post(
  '/:id/onboarding/start',
  projectParam,
  strictBody(startRequestSchema, START_SHAPE),
  async (c) =>
    answer(
      c,
      await startOnboarding({
        projectId: c.req.valid('param').id,
        actor: actorOf(c),
        request: c.req.valid('json').request,
      }),
    ),
);

onboardingRoutes.post(
  '/:id/onboarding/reanalyze',
  projectParam,
  strictBody(reanalyzeRequestSchema, REANALYZE_SHAPE),
  async (c) =>
    answer(
      c,
      await reanalyzeOnboarding({
        projectId: c.req.valid('param').id,
        actor: actorOf(c),
        reason: c.req.valid('json').reason,
      }),
    ),
);

onboardingRoutes.post('/:id/onboarding/join', projectParam, emptyBody, async (c) =>
  answer(c, await joinOnboarding({ projectId: c.req.valid('param').id, actor: actorOf(c) })),
);

onboardingRoutes.post(
  '/:id/onboarding/questionnaires',
  projectParam,
  strictBody(postQuestionnaireRequestSchema, POST_QUESTIONNAIRE_SHAPE),
  async (c) => {
    const outcome = await postOnboardingQuestionnaire({
      projectId: c.req.valid('param').id,
      actor: actorOf(c),
      body: c.req.valid('json'),
    });
    if (!outcome.ok) return refusedOnboarding(c, outcome.refusals);
    const body: QuestionnaireResponse = { questionnaire: outcome.questionnaire };
    return c.json(body, 201);
  },
);

onboardingRoutes.post(
  '/:id/onboarding/updates',
  projectParam,
  strictBody(postUpdateRequestSchema, POST_UPDATE_SHAPE),
  async (c) =>
    answer(
      c,
      await postOnboardingUpdate({
        projectId: c.req.valid('param').id,
        actor: actorOf(c),
        body: c.req.valid('json'),
      }),
    ),
);

onboardingRoutes.post(
  '/:id/onboarding/done',
  projectParam,
  strictBody(markDoneRequestSchema, MARK_DONE_SHAPE),
  async (c) =>
    answer(
      c,
      await markOnboardingDone({
        projectId: c.req.valid('param').id,
        actor: actorOf(c),
        text: c.req.valid('json').text,
      }),
    ),
);

onboardingRoutes.get('/:id/onboarding/answers', projectParam, async (c) => {
  const outcome = await readAnswers(c.req.valid('param').id, actorOf(c));
  if (!outcome.ok) return refusedOnboarding(c, outcome.refusals);
  return c.json({
    onboarding: outcome.onboarding,
    questionnaires: outcome.questionnaires,
    requests: outcome.requests,
  });
});
