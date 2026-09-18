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

// cm:guard the page is named by a CURSOR and not by an offset, and `cursor` is the opaque `<created_at>|<id>` the previous page's `nextCursor` carried: an offset over a queue that is being answered starts past a row that shifted backward when an earlier one closed, which skips an open decision while `hasMore` still reads complete (ISS-1022).
// cm:guard the cursor is DECODED and shape-checked here and one that fails is refused by name, never absorbed: both silent readings were live on beta and both are defects — an unparseable cursor that is dropped hands the caller page one as though it were the page it asked for, which is a drain loop that never advances, and one passed through to the `::timestamptz` cast leaves a caller's typo as a 500. That is exactly the fault the `uuid` guard on `projectId` below exists to prevent (ISS-1022).
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
    // cm:guard the caller DECLARES this and the door never infers it: a private round is put to whoever asked in a direct room rather than in the conversation's own, and a server that guessed would be deciding in public whether a thing was private (ISS-1091 criterion 19).
    sensitive: z.boolean().optional(),
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
  QUESTION_MESSAGE_REFUSED: 400,
  QUESTION_CURSOR_INVALID: 400,
};

// cm:guard answering and voiding stay a SESSION's, and the test is the CREDENTIAL rather than `agency`: an agency test would have refused some agents and waved the rest through, because until ISS-1003 an agent holding a person's token read `human`. Putting `/api/questions` on the PAT menu (`auth/pat-permissions.ts`) made these two reachable by every token holding no explicit grant, since an absent grant array reads as the whole menu — this is what keeps that widening to asking, listing and reading back. The one hole in it is `master_or_peer`, below, and that hole is opened by an ESTABLISHED identity rather than by a relaxed test.
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
// cm:guard the admission is `c.get('agentUserId')` — set ONLY where the token's owner is an agent account — and never `agency`, and never the token's name. A person's token borrowed by an agent establishes no identity and is refused by this same line, which is the whole of issue rule 6: borrowed authority may act, but it may not claim to be the one speaking. Widening this to `agency === 'agent'` would admit every borrowed token back, since that is where the wrong answer lived.
// cm:guard the `blockerKind` test stays, and it is not decoration: a question parked on a HUMAN is parked on a human, and an agent answering it is the machine deciding a thing that was escalated precisely because a machine should not. Only the peer-blocked kind is a question an agent was ever the right answerer for.
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
// cm:guard BOTH mounts, because Hono's `*` does not match the bare `/` this router's ask and list routes are served on — drop either line and those routes answer every caller before any auth middleware runs.
// cm:edge lockstep -> packages/core/src/index.ts — mounted at `/api/questions`, which is also the prefix `auth/pat-permissions.ts` names. `pat-allowlist-reachable.test.ts` resolves a prefix to the router mounted at EXACTLY it, so mounting this bare at `/api` again would fail that test by name rather than quietly.
questionRoutes.use('/', requireAuth(), assertEmailVerified());
questionRoutes.use('*', requireAuth(), assertEmailVerified());

// cm:guard the project arm is PAGED and the issue arm is not, and the asymmetry is deliberate: an issue's questions are a thread a person reads whole, a project's are a queue that grew unbounded and was returning every row with its full `steps` history. The default limit is what an unchanged caller now gets; `total` tells it how many are waiting, and `nextCursor` is how it reaches them (ISS-1022).
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
  if (c.get('principal') === 'pat') {
    const agentUserId = c.get('agentUserId');
    // cm:guard the question is read BEFORE the credential is judged, because which refusal is owed depends on what the question is blocked on: a question parked on a PERSON is answered by a person whatever credential asks, while one parked on another agent has exactly one answerer and the refusal has to name it. Judge the credential first and a person holding a token is sent to sign in for a question no person was ever the right answerer for.
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
