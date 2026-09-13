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
  projectQuestionsFor,
  readQuestionFor,
  readQuestionsForIssue,
} from './read.js';
import { type QuestionRefusalCode, QuestionRefused, voidQuestion } from './write.js';

const uuid = z.uuid();

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
  })
  .strict();

const badRequest = (message: string) =>
  new HTTPException(400, { message, cause: { code: 'BAD_REQUEST' } });

const notFound = (what: 'question' | 'issue' = 'question') =>
  new HTTPException(404, { message: `${what} not found`, cause: { code: 'NOT_FOUND' } });

// cm:guard EVERY `:id` handler reads the question id through here, for the reason the list route's own uuid guard states: `agent_questions.id` is a uuid column and a malformed literal raises 22P02, which leaves the handler as a 500 — a caller's typo must not read as a server fault, and the read-back door an agent uses is `GET /questions/:id`.
function questionId(c: { req: { param: (k: string) => string } }): string {
  const id = c.req.param('id');
  if (!uuid.safeParse(id).success) throw badRequest('the question id must be a uuid');
  return id;
}

// cm:guard the status is a property of the REFUSAL and not of the verb: a stale round and an already-answered question are conflicts a refresh settles, an unknown option is a malformed request, and only authority is a permission. Collapsing them back to one 403 tells a caller to go and ask for access when what it owes is a reload (ISS-980 criterion 40).
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
};

// cm:guard answering and voiding stay a SESSION's, and the test is the credential rather than `agency`: `middleware/auth.ts` carries the measurement that an agent holding a person's token reads `human`, so an agency test would refuse some agents and wave the rest through. Putting `/api/questions` on the PAT menu (`auth/pat-permissions.ts`) made these two reachable by every token holding no explicit grant, since an absent grant array reads as the whole menu — this is what keeps that widening to asking, listing and reading back.
const sessionOnly = (verb: string) =>
  new HTTPException(403, {
    message:
      `a question is ${verb} by a person in a session, and this request carries a personal ` +
      'access token. Sign in to answer it, or reply in the room the question was delivered to.',
    cause: { code: 'QUESTION_NEEDS_SESSION' },
  });

const refused = (e: QuestionRefused) =>
  new HTTPException(REFUSAL_STATUS[e.code], { message: e.message, cause: { code: e.code } });

export const questionRoutes = new Hono<{ Variables: AuthVars }>();
// cm:guard BOTH mounts, because Hono's `*` does not match the bare `/` this router's ask and list routes are served on — drop either line and those routes answer every caller before any auth middleware runs.
// cm:edge lockstep -> packages/core/src/index.ts — mounted at `/api/questions`, which is also the prefix `auth/pat-permissions.ts` names. `pat-allowlist-reachable.test.ts` resolves a prefix to the router mounted at EXACTLY it, so mounting this bare at `/api` again would fail that test by name rather than quietly.
questionRoutes.use('/', requireAuth(), assertEmailVerified());
questionRoutes.use('*', requireAuth(), assertEmailVerified());

// cm:guard the uuid is checked BEFORE either query reaches postgres: `issue_id` and `project_id` are uuid columns and a malformed literal raises 22P02, which leaves the handler as a 500 — a caller's typo must not read as a server fault.
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
    const open = await projectQuestionsFor(
      projectId,
      c.get('userId'),
      status as (typeof questionStatuses)[number] | undefined,
    );
    if (!open) throw notFound();
    return c.json({ questions: open });
  }
  if (!uuid.safeParse(issueId).success) throw badRequest('issueId must be a uuid');
  const seen = await readQuestionsForIssue(issueId as string, c.get('userId'));
  if (!seen) throw notFound();
  return c.json({ questions: seen });
});

// cm:guard the project is NOT a field of this body: `askAs` reads it off the issue, so the crossed row `ISS-989` had to refuse cannot be asked for here at all. A `projectId` added to this schema puts that row back within reach.
// cm:guard neither `agentSessionId` nor the cost triple is a field of this body, and `agentSessionId` must not become one: `agent_session_id` is a foreign key, so a caller-named session that does not exist leaves the insert as a 23503 and the handler as a 500 — a caller's typo reading as a server fault, which is what the uuid guard on the list route above exists to prevent. A door that wants the session must resolve it from the credential, never take it. The cost triple counts claims and workspaces a BOX holds while it waits, and a caller holding a token holds none.
questionRoutes.post('/', async (c) => {
  const body = await c.req.json().catch(() => null);
  const parsed = askSchema.safeParse(body);
  if (!parsed.success) throw badRequest(z.prettifyError(parsed.error));
  const { parkDeadlineAt, blockerKind, options, ...rest } = parsed.data;
  try {
    const asked = await askAs({
      ...rest,
      // cm:why an absent `fingerprint` is dropped rather than sent as `undefined`: `exactOptionalPropertyTypes` makes the present-but-undefined key a different type from the missing one, and `checkOptions` reads the key.
      options: options.map(({ fingerprint, ...o }) => (fingerprint ? { ...o, fingerprint } : o)),
      blockerKind: blockerKind ?? 'human',
      parkDeadlineAt: parkDeadlineAt ? new Date(parkDeadlineAt) : undefined,
      userId: c.get('userId'),
    });
    // cm:guard what is missing here is the ISSUE, and the refusal says so: `askAs` answers null both for an issue nothing names and for one whose project this caller holds no role on, which must stay indistinguishable — naming the issue keeps them so while telling the caller which of the two ids it got wrong.
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

// cm:guard the refusal is a coded status carrying the option's authority, never a silent no-op or a 200 with nothing written. A locked option that answers anyway is a lock drawn on the screen and nowhere else (ISS-964 criterion 15).
// cm:guard `round` is REQUIRED and is never defaulted to the question's current round: the answer binds to the round the person was shown, and defaulting it applies a choice made about round 1 to a round 3 they never read (ISS-980 criterion 39).
// cm:guard exactly ONE of `optionId` and `text` is read, and a body carrying both is refused here rather than resolved by precedence: a caller that sent both does not know which round it is answering, and picking one for them answers a question they did not read (ISS-996).
questionRoutes.post('/:id/answer', async (c) => {
  if (c.get('principal') === 'pat') throw sessionOnly('answered');
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
