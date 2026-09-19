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
import { type AuthVars, assertEmailVerified, requireAuth } from '../middleware/auth.js';
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
  QUESTION_AUTHORITY_REQUIRED: 403,
  QUESTION_ISSUE_ELSEWHERE: 400,
  QUESTION_REASON_REQUIRED: 400,
  QUESTION_OPTIONS_REQUIRED: 400,
  QUESTION_RECOMMENDED_UNKNOWN: 400,
  QUESTION_OPTION_IDS_DUPLICATE: 400,
  QUESTION_SHAPE_INVALID: 400,
  QUESTION_ANSWER_WRONG_SHAPE: 400,
  QUESTION_MESSAGE_REFUSED: 400,
  QUESTION_CURSOR_INVALID: 400,
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

questionRoutes.get('/', async (c) => {
  const issueId = c.req.query('issueId');
  const projectId = c.req.query('projectId');
  if (!issueId && !projectId) throw badRequest('issueId or projectId is required');
  if (issueId && projectId) {
    throw badRequest('name issueId or projectId, not both — they are two different questions');
  }
  const status = c.req.query('status');
  if (status && !questionStatuses.includes(status as (typeof questionStatuses)[number])) {
    throw badRequest(`status must be one of ${questionStatuses.join(', ')}`);
  }
  if (projectId) {
    if (!uuid.safeParse(projectId).success) throw badRequest('projectId must be a uuid');
    const page = pageSchema.safeParse({
      limit: c.req.query('limit'),
      cursor: c.req.query('cursor'),
    });
    if (!page.success) throw badRequest(z.prettifyError(page.error));
    try {
      const open = await projectQuestionsFor(
        projectId,
        c.get('userId'),
        status as (typeof questionStatuses)[number] | undefined,
        page.data,
      );
      if (!open) throw notFound();
      return c.json(open);
    } catch (e) {
      if (e instanceof QuestionRefused) throw refused(e);
      throw e;
    }
  }
  if (!uuid.safeParse(issueId).success) throw badRequest('issueId must be a uuid');
  const seen = await readQuestionsForIssue(issueId as string, c.get('userId'));
  if (!seen) throw notFound();
  return c.json({ questions: seen });
});

questionRoutes.post('/', async (c) => {
  const body = await c.req.json().catch(() => null);
  const parsed = askSchema.safeParse(body);
  if (!parsed.success) throw badRequest(z.prettifyError(parsed.error));
  const { parkDeadlineAt, blockerKind, options, ...rest } = parsed.data;
  try {
    const asked = await askAs({
      ...rest,
      options: options.map(({ fingerprint, ...o }) => (fingerprint ? { ...o, fingerprint } : o)),
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

questionRoutes.post('/:id/answer', async (c) => {
  if (c.get('principal') === 'pat') {
    const agentUserId = c.get('agentUserId');
    const seen = await readQuestionFor(questionId(c), agentUserId ?? c.get('userId'));
    if (!seen) throw notFound();
    if (seen.blockerKind !== 'master_or_peer') throw sessionOnly('answered');
    if (!agentUserId) throw peerBlockedOnly();
  }
  const body = await c.req
    .json<{ optionId?: string; text?: string; round?: number }>()
    .catch(() => ({}) as { optionId?: string; text?: string; round?: number });
  const hasOption = typeof body.optionId === 'string' && body.optionId.length > 0;
  const hasText = typeof body.text === 'string' && body.text.trim().length > 0;
  if (hasOption && hasText) throw badRequest('send optionId or text, never both');
  if (!hasOption && !hasText) throw badRequest('optionId or text is required');
  if (!Number.isInteger(body.round)) throw badRequest('round is required, as an integer');
  try {
    return c.json(
      await answerAs({
        questionId: questionId(c),
        answer: hasOption
          ? { kind: 'option', optionId: body.optionId as string }
          : { kind: 'text', text: body.text as string },
        round: body.round as number,
        userId: c.get('userId'),
      }),
    );
  } catch (e) {
    if (e instanceof QuestionRefused) throw refused(e);
    throw e;
  }
});

questionRoutes.post('/:id/void', async (c) => {
  if (c.get('principal') === 'pat') throw sessionOnly('voided');
  const body = await c.req.json<{ reason?: string }>().catch(() => ({}) as { reason?: string });
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
});
