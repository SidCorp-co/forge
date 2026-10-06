// A parked decision over HTTP: ask one, list a project's or an issue's, read one, answer one, void one.
//
// A rule refusal leaves as the refusal envelope `middleware/error.ts` answers a thrown refusal with.

import type { ActorAgency } from '@forge/contracts/permissions';
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
import { egressAs } from '../lib/data-egress.js';
import { type AuthVars, assertEmailVerified, requireAuth, restActor } from '../middleware/auth.js';
import { forbidden } from '../middleware/route-errors.js';
import { zValidator } from '../middleware/zod-validator.js';
import { doorOfRequest } from './ports.js';
import {
  answerAs,
  askAs,
  decodeCursor,
  projectQuestionsFor,
  questionSurface,
  readQuestionFor,
  readQuestionsForIssue,
} from './read.js';

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
  stillWaits: z
    .object(
      {
        reason: z
          .string({ error: 'stillWaits.reason must be a string' })
          .max(1000, { error: 'stillWaits.reason is at most 1000 characters' }),
        blockedBy: z
          .string({ error: 'stillWaits.blockedBy must be an issue key or id' })
          .max(200)
          .optional(),
      },
      {
        error:
          'stillWaits is { reason, blockedBy? }: what the issue still waits on after this answer',
      },
    )
    .strict()
    .optional(),
});

const notFound = (what: 'question' | 'issue' = 'question') =>
  new HTTPException(404, { message: `${what} not found`, cause: { code: 'NOT_FOUND' } });

type ShownQuestion = {
  id: string;
  status: string;
  projectId: string;
  issueId: string | null;
  feedbackId: string | null;
  requirementId: string | null;
  batchId: string | null;
};

/** A question as the project's data policy lets this reader see it; withheld text keeps its ids. */
async function shown<Q extends ShownQuestion>(agency: ActorAgency | undefined, q: Q) {
  if (!agency)
    throw new Error('questions: a question read reached its handler without an auth gate');
  const out = await egressAs(
    { agency },
    q.projectId,
    await questionSurface(q),
    q,
    `question ${q.id}`,
  );
  return out.ok
    ? out.value
    : { id: q.id, status: q.status, issueId: q.issueId, withheld: out.refusal };
}

function questionId(c: { req: { param: (k: string) => string } }): string {
  const id = c.req.param('id');
  if (!uuid.safeParse(id).success) throw badRequest('the question id must be a uuid');
  return id;
}

const sessionOnly = (verb: string) =>
  forbidden(
    `a question is ${verb} by a person in a session, and this request carries a personal ` +
      'access token. Sign in to answer it, or reply in the room the question was delivered to.',
  );

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
  forbidden(
    'this question is blocked on another agent, and this request carries a personal access ' +
      'token owned by a person, which establishes nobody: a borrowed credential may act but may ' +
      'not say who is speaking. Answer it with the agent’s OWN Agent Access Token — an org admin ' +
      'mints one for an existing agent at POST /api/orgs/:orgId/agents/:agentUserId/tokens. Or ' +
      'sign in and answer it as a person.',
  );

export const questionRoutes = new Hono<{ Variables: AuthVars }>();
questionRoutes.use('/', requireAuth(), assertEmailVerified());
questionRoutes.use('*', requireAuth(), assertEmailVerified());

questionRoutes.get('/', zValidator('query', listQuery), async (c) => {
  const { issueId, projectId, issue: issueScope, status, limit, cursor } = c.req.valid('query');
  if (!issueId && !projectId) throw badRequest('issueId or projectId is required');
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
        open.questions.map((q) => shown(agency, q as typeof q & ShownQuestion)),
      ),
    });
  }
  const seen = await readQuestionsForIssue(issueId as string, c.get('userId'));
  if (!seen) throw notFound();
  const agency = c.get('agency');
  return c.json({ questions: await Promise.all(seen.map((q) => shown(agency, q))) });
});

questionRoutes.post('/', zValidator('json', askSchema), async (c) => {
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
});

questionRoutes.get('/:id', async (c) => {
  const seen = await readQuestionFor(questionId(c), c.get('userId'));
  if (!seen) throw notFound();
  return c.json(await shown(c.get('agency'), seen));
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
  zValidator('json', answerBody),
  async (c) => {
    const body = c.req.valid('json');
    const hasOption = typeof body.optionId === 'string' && body.optionId.length > 0;
    const hasText = typeof body.text === 'string' && body.text.trim().length > 0;
    if (hasOption && hasText) throw badRequest('send optionId or text, never both');
    if (!hasOption && !hasText) throw badRequest('optionId or text is required');
    return c.json(
      await answerAs({
        questionId: questionId(c),
        answer: hasOption
          ? { kind: 'option', optionId: body.optionId as string }
          : { kind: 'text', text: body.text as string },
        round: body.round,
        userId: c.get('userId'),
        agency: restActor(c).agency,
        via: await doorOfRequest(c),
        ...(body.note === undefined ? {} : { note: body.note }),
        ...(body.stillWaits === undefined ? {} : { stillWaits: body.stillWaits }),
      }),
    );
  },
);
