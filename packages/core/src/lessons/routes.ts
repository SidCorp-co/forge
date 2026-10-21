import {
  DECIDE_CONFUSION_SHAPE,
  decideConfusionRequestSchema,
  EDIT_LESSON_SHAPE,
  editLessonRequestSchema,
  LESSON_REASON_SHAPE,
  lessonReasonRequestSchema,
  lessonsMonthQuerySchema,
  PROPOSE_LESSON_SHAPE,
  proposeLessonRequestSchema,
  RAISE_CONFUSION_SHAPE,
  RECORD_APPLIED_SHAPE,
  raiseConfusionRequestSchema,
  recordAppliedRequestSchema,
} from '@forge/contracts/lessons';
import { type Context, Hono } from 'hono';
import { z } from 'zod';
import { type AuthVars, assertEmailVerified, requireAuth } from '../middleware/auth.js';
import { invalid, strictBody, zValidator } from '../middleware/zod-validator.js';
import { recordApplied } from './applied.js';
import { decideConfusion, markWronglyApplied, raiseConfusion } from './confusions.js';
import { dismissCorrection } from './corrections.js';
import {
  approveLesson,
  editLesson,
  keepLesson,
  type LessonActor,
  proposeLesson,
  rejectLesson,
  retireLesson,
} from './decide.js';
import { readLessonsMonth } from './month.js';
import { chatLessonMarks, lessonViewOf, readLessons } from './read.js';

/** Lessons (L-n, REQ-50), under `/api/projects/:id/lessons`. */
export const lessonRoutes = new Hono<{ Variables: AuthVars }>();

for (const path of ['/:id/lessons', '/:id/lessons/*']) {
  lessonRoutes.use(path, requireAuth(), assertEmailVerified());
}

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
const recordParam = zValidator(
  'param',
  z.object({ id: z.uuid(), rid: z.uuid() }),
  invalid('invalid path: a project uuid and a record uuid'),
);

function actorOf(c: Context<{ Variables: AuthVars }>): LessonActor {
  const agency = c.get('agency');
  if (!agency) throw new Error('lessons: a request reached its handler without an auth gate');
  return { userId: c.get('userId'), agency };
}

const editBody = strictBody(editLessonRequestSchema, EDIT_LESSON_SHAPE);
const reasonBody = strictBody(lessonReasonRequestSchema, LESSON_REASON_SHAPE);
const noBody = strictBody(z.strictObject({}), '{} (no fields)');

lessonRoutes.get('/:id/lessons', projectParam, async (c) =>
  c.json(await readLessons(c.req.valid('param').id, actorOf(c).userId)),
);

lessonRoutes.post(
  '/:id/lessons',
  projectParam,
  strictBody(proposeLessonRequestSchema, PROPOSE_LESSON_SHAPE),
  async (c) => {
    const lesson = await proposeLesson({
      projectId: c.req.valid('param').id,
      actor: actorOf(c),
      body: c.req.valid('json'),
    });
    return c.json({ lesson }, 201);
  },
);

lessonRoutes.get(
  '/:id/lessons/month',
  projectParam,
  zValidator(
    'query',
    lessonsMonthQuerySchema,
    invalid('invalid query: month=YYYY-MM, or none for this month'),
  ),
  async (c) =>
    c.json(
      await readLessonsMonth({
        projectId: c.req.valid('param').id,
        userId: actorOf(c).userId,
        month: c.req.valid('query').month,
      }),
    ),
);

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

lessonRoutes.get('/:id/lessons/chat/:rid', recordParam, async (c) => {
  const { id, rid } = c.req.valid('param');
  return c.json(await chatLessonMarks(id, rid, actorOf(c).userId));
});

lessonRoutes.post('/:id/lessons/applications/:rid/wrong', recordParam, reasonBody, async (c) => {
  const { id, rid } = c.req.valid('param');
  const lesson = await markWronglyApplied({
    projectId: id,
    applicationId: rid,
    actor: actorOf(c),
    reason: c.req.valid('json').reason,
  });
  return c.json({ lesson });
});

lessonRoutes.post(
  '/:id/lessons/confusions/:rid/decide',
  recordParam,
  strictBody(decideConfusionRequestSchema, DECIDE_CONFUSION_SHAPE),
  async (c) => {
    const { id, rid } = c.req.valid('param');
    const lesson = await decideConfusion({
      projectId: id,
      confusionId: rid,
      actor: actorOf(c),
      body: c.req.valid('json'),
    });
    return c.json({ lesson });
  },
);

lessonRoutes.post('/:id/lessons/corrections/:rid/dismiss', recordParam, noBody, async (c) => {
  const { id, rid } = c.req.valid('param');
  await dismissCorrection({ projectId: id, correctionId: rid, userId: actorOf(c).userId });
  return c.body(null, 204);
});

lessonRoutes.get('/:id/lessons/:n', lessonParam, async (c) => {
  const { id, n } = c.req.valid('param');
  return c.json({ lesson: await lessonViewOf(id, n, actorOf(c).userId) });
});

lessonRoutes.patch('/:id/lessons/:n', lessonParam, editBody, async (c) => {
  const { id, n } = c.req.valid('param');
  const lesson = await editLesson({
    projectId: id,
    ref: n,
    actor: actorOf(c),
    body: c.req.valid('json'),
  });
  return c.json({ lesson });
});

lessonRoutes.post('/:id/lessons/:n/approve', lessonParam, editBody, async (c) => {
  const { id, n } = c.req.valid('param');
  const lesson = await approveLesson({
    projectId: id,
    ref: n,
    actor: actorOf(c),
    body: c.req.valid('json'),
  });
  return c.json({ lesson });
});

lessonRoutes.post('/:id/lessons/:n/reject', lessonParam, reasonBody, async (c) => {
  const { id, n } = c.req.valid('param');
  const lesson = await rejectLesson({
    projectId: id,
    ref: n,
    actor: actorOf(c),
    reason: c.req.valid('json').reason,
  });
  return c.json({ lesson });
});

lessonRoutes.post('/:id/lessons/:n/retire', lessonParam, reasonBody, async (c) => {
  const { id, n } = c.req.valid('param');
  const lesson = await retireLesson({
    projectId: id,
    ref: n,
    actor: actorOf(c),
    reason: c.req.valid('json').reason,
  });
  return c.json({ lesson });
});

lessonRoutes.post('/:id/lessons/:n/keep', lessonParam, noBody, async (c) => {
  const { id, n } = c.req.valid('param');
  return c.json({ lesson: await keepLesson({ projectId: id, ref: n, actor: actorOf(c) }) });
});

lessonRoutes.post(
  '/:id/lessons/:n/confusions',
  lessonParam,
  strictBody(raiseConfusionRequestSchema, RAISE_CONFUSION_SHAPE),
  async (c) => {
    const { id, n } = c.req.valid('param');
    const lesson = await raiseConfusion({
      projectId: id,
      ref: n,
      actor: actorOf(c),
      body: c.req.valid('json'),
    });
    return c.json({ lesson }, 201);
  },
);
