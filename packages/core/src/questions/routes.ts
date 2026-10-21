// A parked decision over HTTP: ask one, list a project's or an issue's, read one, answer one, void one.
//
// A rule refusal leaves as the refusal envelope `middleware/error.ts` answers a thrown refusal with.

import { REASON_TEXT_MAX } from '@forge/contracts/comments';
import type { ActorAgency } from '@forge/contracts/permissions';
import {
  QUESTION_ABOUT_SHAPE_SENTENCE,
  questionAboutRequestSchema,
} from '@forge/contracts/questions';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import {
  optionAuthorities,
  optionBindings,
  optionExecutors,
  questionBlockerKinds,
  questionStatuses,
} from '../db/schema-questions.js';
import { isUuid, resolveIssueRouteRef } from '../issues/index.js';
import type { EgressReader } from '../lib/data-egress.js';
import { type AuthVars, assertEmailVerified, requireAuth, restActor } from '../middleware/auth.js';
import { fieldShape, strictBody, zValidator } from '../middleware/zod-validator.js';
import { assertTokenMayAnswer } from './answer-door.js';
import { ANSWER_SHAPE, answerBody, givenAnswerOf } from './answer-input.js';
import { doorOfRequest } from './ports.js';
import {
  answerAs,
  askAs,
  decodeCursor,
  projectQuestionsFor,
  readQuestionFor,
  readQuestionsForIssue,
} from './read.js';
import { type ShownQuestion, shownQuestion as shown } from './shown.js';
import { voidQuestionAs } from './void-door.js';

const uuid = z.uuid();

const pageSchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).optional().default(50),
  cursor: z
    .string()
    .min(3)
    .max(200)
    .refine((v) => decodeCursor(v) !== null, {
      message:
        'cursor must be the `nextCursor` of the previous page, sent back exactly as it arrived',
    })
    .optional(),
});

const askSchema = z
  .object({
    issueId: uuid,
    prompt: z.string().trim().min(1).max(8000),
    options: z
      .array(
        z
          .object({
            id: z.string().trim().min(1).max(100),
            label: z.string().trim().min(1).max(500),
            authority: z.enum(optionAuthorities),
            bindsTo: z.enum(optionBindings),
            executedBy: z.enum(optionExecutors),
            fingerprint: z.string().trim().min(1).max(500).optional(),
          })
          .strict(),
      )
      .max(10),
    recommendedOptionId: z.string().trim().min(1).max(100),
    blockerKind: z.enum(questionBlockerKinds).optional(),
    assumed: z.record(z.string(), z.unknown()).optional(),
    maxRounds: z.number().int().min(1).max(10).optional(),
    parkDeadlineAt: z.iso.datetime().optional(),
    sensitive: z.boolean().optional(),
    about: questionAboutRequestSchema.optional(),
  })
  .strict();

const badRequest = (message: string) =>
  new HTTPException(400, { message, cause: { code: 'BAD_REQUEST' } });

const listQuery = z.object({
  issueId: z
    .string({
      error: 'issueId is an issue uuid, or its display key with projectId naming its project',
    })
    .trim()
    .min(1)
    .max(200)
    .optional(),
  projectId: z.uuid({ error: 'projectId must be a uuid' }).optional(),
  issue: z
    .literal('none', {
      error: 'issue takes one value, `none`, for the questions that name no issue',
    })
    .optional(),
  status: z
    .enum(questionStatuses, { error: `status must be one of ${questionStatuses.join(', ')}` })
    .optional(),
  limit: pageSchema.shape.limit,
  cursor: pageSchema.shape.cursor,
});

const notFound = (what: 'question' | 'issue' = 'question') =>
  new HTTPException(404, { message: `${what} not found`, cause: { code: 'NOT_FOUND' } });

function readerOf(agency: ActorAgency | undefined): EgressReader {
  if (!agency)
    throw new Error('questions: a question read reached its handler without an auth gate');
  return { agency };
}

function questionId(c: { req: { param: (k: string) => string } }): string {
  const id = c.req.param('id');
  if (!uuid.safeParse(id).success) throw badRequest('the question id must be a uuid');
  return id;
}

export const questionRoutes = new Hono<{ Variables: AuthVars }>();
questionRoutes.use('/', requireAuth(), assertEmailVerified());
questionRoutes.use('*', requireAuth(), assertEmailVerified());

questionRoutes.get('/', zValidator('query', listQuery), async (c) => {
  const { issueId, projectId, issue: issueScope, status, limit, cursor } = c.req.valid('query');
  if (!issueId && !projectId) throw badRequest('issueId or projectId is required');
  if (issueId && !isUuid(issueId)) {
    const issue = await resolveIssueRouteRef(issueId, projectId, c.get('userId'));
    return c.json(await issueQuestions(issue.id, c.get('userId'), c.get('agency')));
  }
  if (issueId && projectId) {
    throw badRequest('name issueId or projectId, not both — they are two different questions');
  }
  if (projectId) {
    const open = await projectQuestionsFor(
      projectId,
      c.get('userId'),
      status,
      { limit, cursor },
      issueScope === 'none',
    );
    if (!open) throw notFound();
    const agency = c.get('agency');
    return c.json({
      ...open,
      questions: await Promise.all(
        open.questions.map((q) => shown(readerOf(agency), q as typeof q & ShownQuestion)),
      ),
    });
  }
  return c.json(await issueQuestions(issueId as string, c.get('userId'), c.get('agency')));
});

async function issueQuestions(issueId: string, userId: string, agency: AuthVars['agency']) {
  const seen = await readQuestionsForIssue(issueId, userId);
  if (!seen) throw notFound();
  return { questions: await Promise.all(seen.map((q) => shown(readerOf(agency), q))) };
}

questionRoutes.post(
  '/',
  zValidator(
    'json',
    askSchema,
    fieldShape('about', 'QUESTION_ABOUT_SHAPE', QUESTION_ABOUT_SHAPE_SENTENCE),
  ),
  async (c) => {
    const { parkDeadlineAt, blockerKind, options, recommendedOptionId, ...rest } =
      c.req.valid('json');
    const asked = await askAs({
      ...rest,
      answer: {
        shape: 'choice',
        options: options.map(({ fingerprint, ...o }) => (fingerprint ? { ...o, fingerprint } : o)),
        recommendedOptionId,
      },
      blockerKind: blockerKind ?? 'human',
      parkDeadlineAt: parkDeadlineAt ? new Date(parkDeadlineAt) : undefined,
      userId: c.get('userId'),
    });
    if (!asked) throw notFound('issue');
    return c.json(asked, 201);
  },
);

questionRoutes.get('/:id', async (c) => {
  const seen = await readQuestionFor(questionId(c), c.get('userId'));
  if (!seen) throw notFound();
  return c.json(await shown(readerOf(c.get('agency')), seen));
});

questionRoutes.post(
  '/:id/answer',
  async (c, next) => {
    if (c.get('principal') === 'pat') {
      const tokenId = c.get('patTokenId');
      if (!tokenId)
        throw new Error('questions: a token request reached the answer without its token id');
      await assertTokenMayAnswer({
        questionId: questionId(c),
        userId: c.get('userId'),
        agentUserId: c.get('agentUserId') ?? null,
        tokenId,
      });
    }
    await next();
  },
  strictBody(answerBody, ANSWER_SHAPE),
  async (c) => {
    return c.json(
      await answerAs({
        questionId: questionId(c),
        ...givenAnswerOf(c.req.valid('json')),
        userId: c.get('userId'),
        agency: restActor(c).agency,
        via: await doorOfRequest(c),
      }),
    );
  },
);

questionRoutes.post(
  '/:id/void',
  strictBody(
    z.strictObject({ reason: z.string().trim().min(1).max(REASON_TEXT_MAX) }),
    '{ reason } says why the question no longer needs its answer',
  ),
  async (c) =>
    c.json(
      await voidQuestionAs({
        questionId: questionId(c),
        userId: c.get('userId'),
        agency: restActor(c).agency,
        reason: c.req.valid('json').reason,
      }),
    ),
);
