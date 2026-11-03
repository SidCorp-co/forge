import {
  LESSONS_CORRECTIONS_SHAPE,
  LESSONS_LEARNED_MAX_DAYS,
  LESSONS_LEARNED_SHAPE,
  lessonsCorrectionsQuerySchema,
  lessonsLearnedQuerySchema,
  RAISE_CONFUSION_SHAPE,
  type RaiseConfusionResponse,
  RECORD_APPLIED_SHAPE,
  raiseConfusionRequestSchema,
  recordAppliedRequestSchema,
} from '@forge/contracts/lessons';
import { type Context, Hono } from 'hono';
import { z } from 'zod';
import { type AuthVars, assertEmailVerified, requireAuth } from '../middleware/auth.js';
import { invalid, strictBody, zValidator } from '../middleware/zod-validator.js';
import { requiresOnParam } from '../permissions/index.js';
import { recordApplied } from './applied.js';
import { raiseConfusion } from './confusions.js';
import { correctionsSaid } from './corrections-read.js';
import type { LessonActor } from './decide.js';
import { lessonsLearned } from './learned.js';
import { refuse } from './refuse.js';

/**
 * Lessons (L-n, REQ-50), under `/api/projects/:id/lessons`: the two doors agents write through, and
 * the one they read a window's learning from. A run or a master records the lessons an output applied
 * (BC-4), an agent reports a confusion to the steward (BC-5), and the daily review's master reads what
 * a day taught (`learned.ts`, ISS-867) and the corrections said in a window (`corrections-read.ts`). Lessons are internal to Forge (BC-9): no route reads one for
 * a screen, and the steward and core settle every one (`steward/lessons-pass.ts`).
 */
export const lessonRoutes = new Hono<{ Variables: AuthVars }>();

lessonRoutes.use('/:id/lessons/*', requireAuth(), assertEmailVerified());

const projectParam = zValidator(
  'param',
  z.object({ id: z.uuid() }),
  invalid('invalid path: the project id is a uuid'),
);
const lessonParam = zValidator(
  'param',
  z.object({ id: z.uuid(), n: z.string().trim().min(1).max(64) }),
  invalid('invalid path: a project uuid and a lesson number (L-3 or 3) or uuid'),
);

function actorOf(c: Context<{ Variables: AuthVars }>): LessonActor {
  const agency = c.get('agency');
  if (!agency) throw new Error('lessons: a request reached its handler without an auth gate');
  return { userId: c.get('userId'), agency };
}

const learnedBad = (detail: string) =>
  refuse('LESSON_WINDOW_INVALID', `${detail}; send ${LESSONS_LEARNED_SHAPE}`, '/since');

lessonRoutes.get(
  '/:id/lessons/learned',
  projectParam,
  requiresOnParam('project.read', 'id'),
  zValidator(
    'query',
    lessonsLearnedQuerySchema,
    invalid(`invalid query: ${LESSONS_LEARNED_SHAPE}`, 'LESSON_WINDOW_INVALID'),
  ),
  async (c) => {
    const { id } = c.req.valid('param');
    const q = c.req.valid('query');
    const since = new Date(q.since);
    const until = new Date(q.until);
    if (since >= until) throw learnedBad(`since (${q.since}) is not before until (${q.until})`);
    if (until.getTime() - since.getTime() > LESSONS_LEARNED_MAX_DAYS * 86_400_000)
      throw learnedBad(`the window is longer than ${LESSONS_LEARNED_MAX_DAYS} days`);
    return c.json(await lessonsLearned(id, since, until));
  },
);

lessonRoutes.get(
  '/:id/lessons/corrections',
  projectParam,
  requiresOnParam('project.read', 'id'),
  zValidator(
    'query',
    lessonsCorrectionsQuerySchema,
    invalid(`invalid query: ${LESSONS_CORRECTIONS_SHAPE}`, 'LESSON_WINDOW_INVALID'),
  ),
  async (c) => {
    const { id } = c.req.valid('param');
    const q = c.req.valid('query');
    const since = new Date(q.since);
    const until = new Date(q.until);
    const bad = (detail: string) =>
      refuse('LESSON_WINDOW_INVALID', `${detail}; send ${LESSONS_CORRECTIONS_SHAPE}`, '/since');
    if (since >= until) throw bad(`since (${q.since}) is not before until (${q.until})`);
    if (until.getTime() - since.getTime() > LESSONS_LEARNED_MAX_DAYS * 86_400_000)
      throw bad(`the window is longer than ${LESSONS_LEARNED_MAX_DAYS} days`);
    return c.json(await correctionsSaid(id, since, until, q.source));
  },
);

lessonRoutes.post(
  '/:id/lessons/applied',
  projectParam,
  requiresOnParam('project.write', 'id'),
  strictBody(recordAppliedRequestSchema, RECORD_APPLIED_SHAPE),
  async (c) =>
    c.json(
      await recordApplied({
        projectId: c.req.valid('param').id,
        userId: actorOf(c).userId,
        body: c.req.valid('json'),
      }),
    ),
);

lessonRoutes.post(
  '/:id/lessons/:n/confusions',
  lessonParam,
  requiresOnParam('project.write', 'id'),
  strictBody(raiseConfusionRequestSchema, RAISE_CONFUSION_SHAPE),
  async (c) => {
    const { id, n } = c.req.valid('param');
    const moved = await raiseConfusion({
      projectId: id,
      ref: n,
      actor: actorOf(c),
      body: c.req.valid('json'),
    });
    const answer: RaiseConfusionResponse = { lesson: { key: moved.key, status: moved.status } };
    return c.json(answer, 201);
  },
);
