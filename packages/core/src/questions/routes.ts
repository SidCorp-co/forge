// A parked decision over HTTP: ask one, list a project's or an issue's, read one, answer one, void one.
//
// A rule refusal leaves as the refusal envelope `middleware/error.ts` answers a thrown refusal with.

import { REASON_TEXT_MAX } from '@forge/contracts/comments';
import type { ActorAgency } from '@forge/contracts/permissions';
import { plainDecisionSchema } from '@forge/contracts/plain-decision';
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
import { fieldShape, noQuery, strictBody, zValidator } from '../middleware/zod-validator.js';
import { requiresByRule, requiresOnResolved } from '../permissions/index.js';
import { assertTokenMayAnswer } from './answer-door.js';
import { ANSWER_SHAPE, answerBody, givenAnswerOf } from './answer-input.js';
import { askAs } from './ask.js';
import { doorOfRequest } from './ports.js';
import {
  answerAs,
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

// An ask stands on an issue, or on none with `projectId` and `about` (FB-149): `askAs` refuses the
// gaps by name, QUESTION_PROJECT_REQUIRED and QUESTION_SUBJECT_REQUIRED, rather than a bare 400.
const askSchema = z
  .object({
    issueId: uuid.optional(),
    projectId: uuid.optional(),
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
    serious: z
      .boolean()
      .optional()
      .describe(
        'the asker judged it serious: irreversible, real money, credentials or product direction (REQ-79 BC-13); an agent asks a person only for such a decision, on a strict project',
      ),
    rule: z
      .string()
      .trim()
      .min(1)
      .max(200)
      .optional()
      .describe(
        "the slug of this project's own rule (a knowledge entry) that names the person's act asked for (ISS-869): it admits an agent's ask of a person on any gate profile, and the question stays that person's",
      ),
    assumed: z.record(z.string(), z.unknown()).optional(),
    maxRounds: z.number().int().min(1).max(10).optional(),
    parkDeadlineAt: z.iso.datetime().optional(),
    sensitive: z.boolean().optional(),
    about: questionAboutRequestSchema.optional(),
    plain: plainDecisionSchema.optional(),
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

const notFound = (what: 'question' | 'issue' | 'project' = 'question') =>
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

// a question is reached through its project or its issue, and a caller with no role there is
// answered not found, never refused, so these are declared by the rule that reads it; no floor
const LISTED = requiresByRule(
  'questions/read.ts:accessOn',
  'the projects the caller has a role in; another answers not found, as does a question it cannot read',
);
const READ_ONE = requiresByRule(
  'questions/read.ts:readQuestionFor',
  "the question's row decides who reads it; another answers not found",
);
const ASK = requiresByRule(
  'questions/ask.ts:askAs',
  "project.write on the project the body names, or its issue's; one the caller has no role on is not found",
);
const VOID = requiresByRule(
  'questions/void-door.ts:voidQuestionAs',
  "project.write on the question's project, then the question's own named refusals",
);
questionRoutes.use('/', requireAuth(), assertEmailVerified());
questionRoutes.use('*', requireAuth(), assertEmailVerified());

questionRoutes.get('/', zValidator('query', listQuery), LISTED, async (c) => {
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
  ASK,
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
      agency: restActor(c).agency,
    });
    if (!asked) throw notFound(rest.issueId ? 'issue' : 'project');
    return c.json(asked, 201);
  },
);

questionRoutes.get('/:id', READ_ONE, noQuery, async (c) => {
  const seen = await readQuestionFor(questionId(c), c.get('userId'));
  if (!seen) throw notFound();
  return c.json(await shown(readerOf(c.get('agency')), seen));
});

questionRoutes.post(
  '/:id/answer',
  requiresOnResolved(
    'project.write',
    'the project of the question `:id` names; an admin option asks project.admin, a rule of the chosen option',
  ),
  strictBody(answerBody, ANSWER_SHAPE),
  async (c) => {
    if (c.get('principal') === 'pat') {
      const tokenId = c.get('patTokenId');
      if (!tokenId)
        throw new Error('questions: a token request reached the answer without its token id');
      await assertTokenMayAnswer({
        questionId: questionId(c),
        userId: c.get('userId'),
        agentUserId: c.get('agentUserId') ?? null,
        tokenId,
        agency: restActor(c).agency,
        note: c.req.valid('json').note,
      });
    }
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
  VOID,
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
