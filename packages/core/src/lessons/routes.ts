import {
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
import { recordApplied } from './applied.js';
import { raiseConfusion } from './confusions.js';
import type { LessonActor } from './decide.js';

/**
 * Lessons (L-n, REQ-50), under `/api/projects/:id/lessons`: the two doors agents write through. A run
 * or a master records the lessons an output applied (BC-4), and an agent reports a confusion to the
 * steward (BC-5). Lessons are internal to Forge (BC-9): no route reads one for a screen, and the
 * steward and core settle every one (`steward/lessons-pass.ts`).
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

lessonRoutes.post(
  '/:id/lessons/applied',
  projectParam,
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
