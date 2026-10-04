import {
  type QuestionnaireResponse,
  SUBMIT_ANSWERS_SHAPE,
  submitAnswersRequestSchema,
} from '@forge/contracts/onboarding';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import { db } from '../db/client.js';
import { type AuthVars, assertEmailVerified, requireAuth } from '../middleware/auth.js';
import { strictBody, zValidator } from '../middleware/zod-validator.js';
import { actorOf, refusedOnboarding } from '../onboarding/routes.js';
import { afterOnboardingSubmit, onboardingSubmittedIn } from '../onboarding/service.js';
import { batchIn, batchView, questionnairesAs } from './read.js';
import { submitAnswers } from './service.js';
import { actorFor, projectResource, requireCan } from '../permissions/index.js';

export const questionnaireRoutes = new Hono<{ Variables: AuthVars }>();

questionnaireRoutes.use('/:id/questionnaires/*', requireAuth(), assertEmailVerified());

const batchParam = zValidator('param', z.object({ id: z.uuid(), bid: z.uuid() }), (r) => {
  if (!r.success)
    throw new HTTPException(400, {
      message: 'invalid path: a project uuid and a questionnaire uuid',
      cause: { code: 'BAD_REQUEST' },
    });
});

questionnaireRoutes.get('/:id/questionnaires/:bid', batchParam, async (c) => {
  const { id, bid } = c.req.valid('param');
  await requireCan(actorFor(c.get('userId')), 'project.read', projectResource(id));
  const out = await questionnairesAs(actorOf(c), id, [await batchView(db, id, bid)]);
  if (!out.ok) return refusedOnboarding(c, [out.refusal]);
  const [questionnaire] = out.value;
  if (!questionnaire)
    throw new Error(`questionnaires: batch ${bid} vanished under its egress read`);
  const body: QuestionnaireResponse = { questionnaire };
  return c.json(body);
});

// cm:why the one submit endpoint for every questionnaire, onboarding round or BA clarification alike:
// the thread's owner decides what happens after, never the client
questionnaireRoutes.post(
  '/:id/questionnaires/:bid/answers',
  batchParam,
  strictBody(submitAnswersRequestSchema, SUBMIT_ANSWERS_SHAPE),
  async (c) => {
    const { id, bid } = c.req.valid('param');
    const body = c.req.valid('json');
    const actor = actorOf(c);
    const outcome = await submitAnswers({
      projectId: id,
      batchId: bid,
      actor,
      answers: body.answers,
      skip: body.skip,
      onSubmittedIn: onboardingSubmittedIn,
    });
    if (!outcome.ok) return refusedOnboarding(c, outcome.refusals);
    if (outcome.questionnaire.status === 'submitted') {
      await afterOnboardingSubmit(await batchIn(db, id, bid), actor.userId);
    }
    const res: QuestionnaireResponse = { questionnaire: outcome.questionnaire };
    return c.json(res);
  },
);
