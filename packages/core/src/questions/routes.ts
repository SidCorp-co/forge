// A parked decision over HTTP: ask one, list a project's or an issue's, read one, answer one, void one.
//
// Every refusal here leaves as `{ code, message }`, the body `middleware/error.ts`
// builds for every other route, because the browser's `formatApiError` reads
// `code` first and `message` second and can read neither out of a hand-rolled
// `{ error }` (ISS-980 criterion 40).

import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { z } from 'zod';
import {
  optionAuthorities,
  optionBindings,
  optionExecutors,
  questionBlockerKinds,
  questionStatuses,
} from '../db/schema-questions.js';
import { Refused } from '../ecosystem/channel-act.js';
import { doorOf, tokenIdOf } from '../ecosystem/channel-author.js';
import { type AuthVars, assertEmailVerified, requireAuth } from '../middleware/auth.js';
import { zValidator } from '../middleware/zod-validator.js';
import { refused as refusedByName } from '../project-config/respond.js';
import {
  answerAs,
  askAs,
  decodeCursor,
  projectQuestionsFor,
  readQuestionFor,
  readQuestionsForIssue,
} from './read.js';
import { type QuestionRefusalCode, QuestionRefused, voidQuestion } from './write.js';

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
  })
  .strict();

const badRequest = (message: string) =>
  new HTTPException(400, { message, cause: { code: 'BAD_REQUEST' } });

const listQuery = z.object({
  issueId: z.uuid({ error: 'issueId must be a uuid' }).optional(),
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

const PAGE_FIELDS = new Set<PropertyKey>(['limit', 'cursor']);

const answerBody = z.object({
  optionId: z.string({ error: 'optionId must be a string' }).optional(),
  text: z.string({ error: 'text must be a string' }).optional(),
  round: z
    .number({ error: 'round is required, as an integer' })
    .int({ error: 'round is required, as an integer' }),
  note: z
    .string({ error: 'note must be a string' })
    .max(1000, { error: 'note is at most 1000 characters' })
    .optional(),
});

const voidBody = z.object({ reason: z.string().optional() });

type Parsed = { success: true } | { success: false; error: z.core.$ZodError };

const refuseQuery = (result: Parsed) => {
  if (result.success) return;
  const first = result.error.issues[0];
  throw badRequest(
    first && !PAGE_FIELDS.has(first.path[0] ?? '') ? first.message : z.prettifyError(result.error),
  );
};

const refuseBody = (result: Parsed) => {
  if (!result.success) throw badRequest(z.prettifyError(result.error));
};

const refuseFirst = (result: Parsed) => {
  if (!result.success) throw badRequest(result.error.issues[0]?.message ?? 'invalid body');
};

const notFound = (what: 'question' | 'issue' = 'question') =>
  new HTTPException(404, { message: `${what} not found`, cause: { code: 'NOT_FOUND' } });

function questionId(c: { req: { param: (k: string) => string } }): string {
  const id = c.req.param('id');
  if (!uuid.safeParse(id).success) throw badRequest('the question id must be a uuid');
  return id;
}

const REFUSAL_STATUS: Record<QuestionRefusalCode, ContentfulStatusCode> = {
  QUESTION_REFUSED: 403,
  QUESTION_NOT_FOUND: 404,
  QUESTION_NOT_OPEN: 409,
  QUESTION_EXPIRED: 409,
  QUESTION_ROUND_STALE: 409,
  QUESTION_OPTION_UNKNOWN: 400,
  QUESTION_ISSUE_ELSEWHERE: 400,
  QUESTION_ISSUE_TERMINAL: 409,
  QUESTION_REASON_REQUIRED: 400,
  QUESTION_OPTIONS_REQUIRED: 400,
  QUESTION_RECOMMENDED_UNKNOWN: 400,
  QUESTION_OPTION_IDS_DUPLICATE: 400,
  QUESTION_SHAPE_INVALID: 400,
  QUESTION_ANSWER_WRONG_SHAPE: 400,
  QUESTION_MESSAGE_REFUSED: 400,
  QUESTION_CURSOR_INVALID: 400,
  QUESTION_NOTE_NOT_TAKEN: 400,
  QUESTION_IN_QUESTIONNAIRE: 409,
};

const sessionOnly = (verb: string) =>
  new HTTPException(403, {
    message:
      `a question is ${verb} by a person in a session, and this request carries a personal ` +
      'access token. Sign in to answer it, or reply in the room the question was delivered to.',
    cause: { code: 'QUESTION_NEEDS_SESSION' },
  });

/**
 * A question whose blocker is another agent, answered by a credential that
 * names an agent — and by nothing else (ISS-1003).
 *
 * `blockerKind: 'master_or_peer'` says in the row itself that the thing this
 * run is waiting on is another agent. Before this, no credential could answer
 * it: every token was refused here and no agent held a session, so a peer-
 * blocked park could only ever be cleared by a person standing in for the peer.
 */
const peerBlockedOnly = () =>
  new HTTPException(403, {
    message:
      'this question is blocked on another agent, and this request carries a personal access ' +
      'token owned by a person, which establishes nobody: a borrowed credential may act but may ' +
      'not say who is speaking. Answer it with the agent’s OWN Agent Access Token — an org admin ' +
      'mints one for an existing agent at POST /api/orgs/:orgId/agents/:agentUserId/tokens. Or ' +
      'sign in and answer it as a person.',
    cause: { code: 'QUESTION_NEEDS_AGENT_CREDENTIAL' },
  });

const refused = (e: QuestionRefused) =>
  new HTTPException(REFUSAL_STATUS[e.code], { message: e.message, cause: { code: e.code } });

export const questionRoutes = new Hono<{ Variables: AuthVars }>();
questionRoutes.use('/', requireAuth(), assertEmailVerified());
questionRoutes.use('*', requireAuth(), assertEmailVerified());

questionRoutes.get('/', zValidator('query', listQuery, refuseQuery), async (c) => {
  const { issueId, projectId, issue: issueScope, status, limit, cursor } = c.req.valid('query');
  if (!issueId && !projectId) throw badRequest('issueId or projectId is required');
  if (issueId && projectId) {
    throw badRequest('name issueId or projectId, not both — they are two different questions');
  }
  if (projectId) {
    try {
      const open = await projectQuestionsFor(
        projectId,
        c.get('userId'),
        status,
        { limit, cursor },
        issueScope === 'none',
      );
      if (!open) throw notFound();
      return c.json(open);
    } catch (e) {
      if (e instanceof QuestionRefused) throw refused(e);
      throw e;
    }
  }
  const seen = await readQuestionsForIssue(issueId as string, c.get('userId'));
  if (!seen) throw notFound();
  return c.json({ questions: seen });
});

questionRoutes.post('/', zValidator('json', askSchema, refuseBody), async (c) => {
  const { parkDeadlineAt, blockerKind, options, recommendedOptionId, ...rest } =
    c.req.valid('json');
  try {
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
  } catch (e) {
    if (e instanceof QuestionRefused) throw refused(e);
    throw e;
  }
});

questionRoutes.get('/:id', async (c) => {
  const seen = await readQuestionFor(questionId(c), c.get('userId'));
  if (!seen) throw notFound();
  return c.json(seen);
});

questionRoutes.post(
  '/:id/answer',
  async (c, next) => {
    if (c.get('principal') === 'pat') {
      const agentUserId = c.get('agentUserId');
      const seen = await readQuestionFor(questionId(c), agentUserId ?? c.get('userId'));
      if (!seen) throw notFound();
      if (seen.blockerKind !== 'master_or_peer') throw sessionOnly('answered');
      if (!agentUserId) throw peerBlockedOnly();
    }
    await next();
  },
  zValidator('json', answerBody, refuseFirst),
  async (c) => {
    const body = c.req.valid('json');
    const hasOption = typeof body.optionId === 'string' && body.optionId.length > 0;
    const hasText = typeof body.text === 'string' && body.text.trim().length > 0;
    if (hasOption && hasText) throw badRequest('send optionId or text, never both');
    if (!hasOption && !hasText) throw badRequest('optionId or text is required');
    try {
      return c.json(
        await answerAs({
          questionId: questionId(c),
          answer: hasOption
            ? { kind: 'option', optionId: body.optionId as string }
            : { kind: 'text', text: body.text as string },
          round: body.round,
          userId: c.get('userId'),
          via: await doorOf(tokenIdOf(c)),
          ...(body.note === undefined ? {} : { note: body.note }),
        }),
      );
    } catch (e) {
      if (e instanceof QuestionRefused) throw refused(e);
      if (e instanceof Refused) return refusedByName(c, e.refusals);
      throw e;
    }
  },
);

questionRoutes.post(
  '/:id/void',
  async (c, next) => {
    if (c.get('principal') === 'pat') throw sessionOnly('voided');
    await next();
  },
  zValidator('json', voidBody, refuseBody),
  async (c) => {
    const body = c.req.valid('json');
    const id = questionId(c);
    const seen = await readQuestionFor(id, c.get('userId'));
    if (!seen) throw notFound();
    try {
      await voidQuestion({ questionId: id, reason: body.reason ?? '' });
      return c.json({ ok: true });
    } catch (e) {
      if (e instanceof QuestionRefused) throw refused(e);
      throw e;
    }
  },
);
