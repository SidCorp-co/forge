// Asking a question as somebody, reading one as somebody, answering one as somebody.
//
// Everything here answers from a ROW. The websocket tells a box to look; it
// never carries the answer, so a box offline for the whole episode loses
// latency and nothing else (ISS-964 criterion 12).

import { randomUUID } from 'node:crypto';
import { and, count, desc, eq, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { issues, type ProjectMemberRole } from '../db/schema.js';
import {
  type AnswerShape,
  agentQuestions,
  isChoiceStep,
  type QuestionBlockerKind,
  type QuestionOption,
  type QuestionStatus,
  type QuestionStep,
  questionWaiters,
} from '../db/schema-questions.js';
import { effectiveProjectRole, projectRoleAtLeast } from '../lib/authz.js';
import {
  answerQuestion,
  askQuestion,
  type GivenAnswer,
  mayAnswerFreeText,
  mayChoose,
  QuestionRefused,
} from './write.js';

export type VisibleOption = QuestionOption & { locked: boolean };

// cm:guard a null ROLE is refused as hard as a null access. `effectiveProjectRole` answers `{ role: null }` — not `null` — for a signed-in caller who is neither a project member nor an org member of the owning org, so the earlier `if (!access)` handed that caller the whole question row of any project in the fleet (ISS-980).
async function roleOn(projectId: string, userId: string): Promise<ProjectMemberRole | null> {
  const access = await effectiveProjectRole(userId, projectId);
  return access?.role ?? null;
}

// cm:guard visibility and choosability are SEPARATE. Any member of the project opens the question and reads every option; `authority: admin` locks the CHOICE alone. A question hidden from a writer is the failure criterion 15 names, and it is the one that leaves a queue of decisions only one person can even look at.
// cm:guard the shape reaches the reader as its own field and is never inferred from an empty option list: a free-text round and a choice round whose options failed to write both present as zero options, and a screen that guesses draws an answer box over a decision (ISS-996).
// cm:guard the ONE derivation of the current round's shape, reached by both the issue-scoped read (which carries the whole `steps` history) and the project-scoped list (which carries only the last step, ISS-1022). Two copies would let the list and the detail draw different controls over the same live decision, which is the failure the `answerShape` tag was added to remove.
// cm:guard `prompt` and `round` are part of the shape and not decoration: the list is the only place a caller sees them once `steps` is off the row, and `POST /api/questions/:id/answer` REFUSES an answer that does not carry the round the person was shown. A projection that drops either leaves a queue a reader can see and cannot answer.
function shapeOf(current: QuestionStep | undefined, role: ProjectMemberRole | null) {
  const choice = current ? isChoiceStep(current) : true;
  const options: VisibleOption[] =
    current && isChoiceStep(current)
      ? current.options.map((o) => ({ ...o, locked: !mayChoose(o, role) }))
      : [];
  return {
    answerShape: (choice ? 'choice' : 'free_text') satisfies AnswerShape as AnswerShape,
    options,
    recommendedOptionId: current && isChoiceStep(current) ? current.recommendedOptionId : '',
    needed: current && !isChoiceStep(current) ? current.needed : '',
    locked: choice ? false : !mayAnswerFreeText(role),
    prompt: current?.prompt ?? '',
    round: current?.round ?? 0,
    askedAt: current?.askedAt ?? '',
  };
}

function seenBy<T extends { steps: QuestionStep[] }>(row: T, role: ProjectMemberRole | null) {
  return { ...row, ...shapeOf(row.steps[row.steps.length - 1], role) };
}

/**
 * Ask a question against one issue, as somebody, or `null` when that somebody
 * cannot reach the issue.
 */
// cm:guard the project is READ OFF THE ISSUE and never taken from the caller, so a row whose `project_id` and `issue_id` name different projects is unrepresentable through this door rather than merely refused — `QUESTION_ISSUE_ELSEWHERE` is unreachable from here, and an issue this caller may not reach is the same `null` as an issue that does not exist (ISS-989).
// cm:guard core allocates the id HERE and the runner still mints its own on `POST /api/devices/me/questions`, which is the difference between a caller that has already written half a park locally and one that has not. The guard on `agentQuestions.id` carries which door does which.
export type AskAsInput = {
  userId: string;
  issueId: string;
  prompt: string;
  blockerKind: QuestionBlockerKind;
  options: QuestionOption[];
  recommendedOptionId: string;
  assumed?: Record<string, unknown> | undefined;
  maxRounds?: number | undefined;
  parkDeadlineAt?: Date | undefined;
};

export async function askAs(args: AskAsInput) {
  const [issue] = await db
    .select({ projectId: issues.projectId })
    .from(issues)
    .where(eq(issues.id, args.issueId))
    .limit(1);
  if (!issue?.projectId) return null;
  const role = await roleOn(issue.projectId, args.userId);
  if (!role) return null;
  if (!projectRoleAtLeast(role, 'member')) {
    throw new QuestionRefused(
      'asking a question writes a row, and this caller is a viewer on the project the issue belongs to',
    );
  }
  return askQuestion({
    id: randomUUID(),
    projectId: issue.projectId,
    issueId: args.issueId,
    prompt: args.prompt,
    blockerKind: args.blockerKind,
    // cm:guard this door asks a CHOICE and only a choice: `askSchema` requires an option list, and a free-text round reaches the table through `askParkQuestion` (a park) or the box door, never through a person's ask (ISS-996).
    answer: {
      shape: 'choice',
      options: args.options,
      recommendedOptionId: args.recommendedOptionId,
    },
    ...(args.assumed ? { assumed: args.assumed } : {}),
    ...(args.maxRounds === undefined ? {} : { maxRounds: args.maxRounds }),
    ...(args.parkDeadlineAt ? { parkDeadlineAt: args.parkDeadlineAt } : {}),
  });
}

/**
 * One page of a project's questions, newest first, or null when the caller
 * cannot reach the project.
 */
// cm:guard the `id` tie-break is what makes the order total: two questions asked in the same transaction share a `created_at` to the microsecond, and an order that leaves them free reads a different queue on each call, which is the one thing a caller draining "what is waiting" cannot work with (the same pair `readQuestionsForIssue` orders by).
// cm:guard the list row carries NO `steps` and that is the point of the projection rather than an omission: `steps` is the round-by-round history of every follow-up, it is the widest column on the table, and this queue was returning all of it for every row with no limit at all (ISS-1022). A reader that wants the history opens the question — `readQuestionsForIssue` and `readQuestionFor` both still carry it whole.
// cm:guard what REPLACES it is `currentStep` (the last step, whole) beside `rounds` (how many there are), and the pair is load-bearing rather than a convenience: `QuestionCard` in web-v2 renders the live round off this row on the project queue and off `steps` on the issue panel, so a projection that drops both leaves that card rendering `undefined`. Never send `steps: [currentStep]` instead — a three-round decision would report one.
// cm:guard `total` is the count of the whole scope and is NOT narrowed by the cursor, so a caller draining the queue can say how much is waiting without walking every page. Capping first and reporting the cap would make the figure a restatement of the page size.
export type ProjectQuestionPage = {
  questions: Array<ReturnType<typeof shapeOf> & Record<string, unknown>>;
  total: number;
  hasMore: boolean;
  /** Where the next page starts, as the last row's own `(created_at, id)`. Null on the last page. */
  nextCursor: string | null;
};

/** One page's starting point: base64url over `<created_at microseconds>|<id>` — the order key itself, not a count. */
export type QuestionCursor = string;

// cm:guard the page is a KEYSET over `(created_at, id)` and never an OFFSET, because this set is being answered while it is read: a question on an earlier page closing shifts every row behind it, and an offset then starts past the one it was going to return — a decision skipped, silently, with `hasMore` still saying the walk is complete. A keyset names the row it left off at, so a row leaving the set behind the cursor moves nothing in front of it (ISS-1022).
// cm:guard the cursor carries `created_at` as TEXT at full precision and the predicate casts it back with `::timestamptz`, because a timestamp that has been through a JS `Date` has lost its microseconds and re-matches its own row, which pages forever on the same row (ISS-926 keyset defect).
const CURSOR_KEY =
  /^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(?:\.\d{1,6})?[+-]\d{2}(?::\d{2})?)\|([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;

// cm:guard the cursor is base64url on the wire and the encoding is not decoration: the key it wraps is `2026-09-14 19:40:03.428223+00|<uuid>`, which carries a SPACE and a `+`, and `+` in a query string decodes to a space. A caller that sends back what it was given without escaping it corrupts the timestamp and gets a refusal it cannot read — measured on beta 2026-09-15, where the unescaped form answered 500. base64url has no character a query string touches, so "send back what you were given" is true as written (ISS-1022).
export function encodeCursor(key: string): QuestionCursor {
  return Buffer.from(key, 'utf8').toString('base64url');
}

// cm:guard a cursor that does not DECODE to a `(created_at, id)` key is refused by name and never absorbed. It is a shape check and deliberately not an authenticity one: the cursor grants nothing a caller does not already have, since the page is scoped by their role on the project before the cursor is read at all, so a hand-built key that decodes is a legal starting point rather than a forgery. Both silent paths were live and both are defects: dropping an unparseable cursor hands the caller page one as though it were the page it asked for — a drain loop that never advances — and passing it into the `::timestamptz` cast leaves a caller's typo as a 500, which is the very fault the `uuid` guard on this route's `projectId` exists to prevent. Returning `null` is what lets `questions/routes.ts` answer 400 naming the shape (ISS-1022).
export function decodeCursor(cursor: string): { at: string; id: string } | null {
  let raw: string;
  try {
    raw = Buffer.from(cursor, 'base64url').toString('utf8');
  } catch {
    return null;
  }
  const m = CURSOR_KEY.exec(raw);
  return m?.[1] && m[2] ? { at: m[1], id: m[2] } : null;
}

function cursorPredicate(cursor: QuestionCursor | undefined) {
  if (!cursor) return undefined;
  const key = decodeCursor(cursor);
  if (!key) {
    throw new QuestionRefused(
      'the cursor does not decode to a `(created_at, id)` key: send back the `nextCursor` of the previous page exactly as it arrived',
      'QUESTION_CURSOR_INVALID',
    );
  }
  return sql`(${agentQuestions.createdAt}, ${agentQuestions.id}) < (${key.at}::timestamptz, ${key.id}::uuid)`;
}

export async function projectQuestionsFor(
  projectId: string,
  userId: string,
  status?: QuestionStatus,
  page: { limit: number; cursor?: QuestionCursor | undefined } = { limit: 50 },
): Promise<ProjectQuestionPage | null> {
  const role = await roleOn(projectId, userId);
  if (!role) return null;
  const scope = status
    ? and(eq(agentQuestions.projectId, projectId), eq(agentQuestions.status, status))
    : eq(agentQuestions.projectId, projectId);
  // cm:guard `total` counts the SCOPE and the page reads the scope AND the cursor: a total narrowed by the cursor would shrink with every page and report the tail as the whole (ISS-1022).
  const after = cursorPredicate(page.cursor);
  const where = after ? and(scope, after) : scope;

  const [rows, [totalRow]] = await Promise.all([
    db
      .select({
        id: agentQuestions.id,
        projectId: agentQuestions.projectId,
        issueId: agentQuestions.issueId,
        agentSessionId: agentQuestions.agentSessionId,
        status: agentQuestions.status,
        blockerKind: agentQuestions.blockerKind,
        maxRounds: agentQuestions.maxRounds,
        assumed: agentQuestions.assumed,
        voidReason: agentQuestions.voidReason,
        claimsHeld: agentQuestions.claimsHeld,
        workspacesPinned: agentQuestions.workspacesPinned,
        dependents: agentQuestions.dependents,
        parkDeadlineAt: agentQuestions.parkDeadlineAt,
        endedBy: agentQuestions.endedBy,
        endedReason: agentQuestions.endedReason,
        createdAt: agentQuestions.createdAt,
        updatedAt: agentQuestions.updatedAt,
        rounds: sql<number>`jsonb_array_length(${agentQuestions.steps})::int`,
        currentStep: sql<QuestionStep | null>`${agentQuestions.steps} -> -1`,
        cursor: sql<string>`${agentQuestions.createdAt}::text || '|' || ${agentQuestions.id}::text`,
      })
      .from(agentQuestions)
      .where(where)
      .orderBy(desc(agentQuestions.createdAt), desc(agentQuestions.id))
      .limit(page.limit + 1),
    db.select({ n: count() }).from(agentQuestions).where(scope),
  ]);

  const total = Number(totalRow?.n ?? 0);
  // cm:guard the page asks for `limit + 1` and `hasMore` is the EXISTENCE of that extra row, never the page being full: a last page holding exactly `limit` rows is indistinguishable from a full one, so reading fullness alone tells the queue another page waits and sends it to fetch an empty one — the "Load the rest" control then offers a walk with nothing behind it (ISS-1022). The extra row is dropped before the page is shaped; it is a probe, not content.
  // cm:guard `hasMore` is NOT `total > rows read`, because `total` counts the whole scope while the page counts what is left after the cursor: a row answered behind the reader makes those two disagree forever, ending the walk early on a queue that still has pages.
  const hasMore = rows.length > page.limit;
  const pageRows = hasMore ? rows.slice(0, page.limit) : rows;
  const last = pageRows[pageRows.length - 1];
  return {
    questions: pageRows.map(({ cursor: _cursor, ...row }) => ({
      ...row,
      rounds: Number(row.rounds),
      ...shapeOf(row.currentStep ?? undefined, role),
    })),
    total,
    hasMore,
    nextCursor: hasMore && last ? encodeCursor(last.cursor) : null,
  };
}

export async function readQuestionFor(questionId: string, userId: string) {
  const [row] = await db
    .select()
    .from(agentQuestions)
    .where(eq(agentQuestions.id, questionId))
    .limit(1);
  if (!row?.projectId) return null;
  const role = await roleOn(row.projectId, userId);
  if (!role) return null;
  return seenBy(row, role);
}

/**
 * Every question on one issue, newest first, or null when the caller cannot reach it.
 */
// cm:guard authorised against the ISSUE's project and never against the questions it happens to carry, so an issue with no question answers an empty LIST to a member and `null` to a stranger — collapsing those two makes "you may not look" indistinguishable from "there is nothing to look at" (ISS-980 criteria 20, 22).
// cm:guard the SELECT carries the project too, and the role check above does not stand in for it: `project_id` and `issue_id` are independent columns, so a row naming project A on an issue of project B is representable, and on `issue_id` alone this hands that row — `steps`, every prompt and option of A's decision — to the B member the role check just cleared (ISS-989).
export async function readQuestionsForIssue(issueId: string, userId: string) {
  const [issue] = await db
    .select({ projectId: issues.projectId })
    .from(issues)
    .where(eq(issues.id, issueId))
    .limit(1);
  if (!issue?.projectId) return null;
  const role = await roleOn(issue.projectId, userId);
  if (!role) return null;
  const rows = await db
    .select()
    .from(agentQuestions)
    .where(and(eq(agentQuestions.issueId, issueId), eq(agentQuestions.projectId, issue.projectId)))
    .orderBy(desc(agentQuestions.createdAt), desc(agentQuestions.id));
  return rows.map((row) => seenBy(row, role));
}

// cm:guard the ROLE is resolved here and handed down; the option it governs is read inside `answerQuestion`'s row lock. Authorization stays request-time, as on every other route — locking `agent_questions` does not lock `project_members`, so resolving the role under that lock would buy nothing and cost a join under it.
export async function answerAs(args: {
  questionId: string;
  answer: GivenAnswer;
  round: number;
  userId: string;
}) {
  const [row] = await db
    .select({ projectId: agentQuestions.projectId })
    .from(agentQuestions)
    .where(eq(agentQuestions.id, args.questionId))
    .limit(1);
  if (!row?.projectId) {
    throw new QuestionRefused(`no question ${args.questionId}`, 'QUESTION_NOT_FOUND');
  }
  const role = await roleOn(row.projectId, args.userId);
  if (!role) throw new QuestionRefused(`no question ${args.questionId}`, 'QUESTION_NOT_FOUND');
  return answerQuestion({
    questionId: args.questionId,
    answer: args.answer,
    round: args.round,
    by: args.userId,
    role,
  });
}

/**
 * The answer on the record, readable as many times as anyone asks.
 */
// cm:guard the answer is NOT consumed by the read. A revival cancelled by a fence must leave it in place for whoever continues, and a read that cleared it would ask the human the same question again (ISS-964 criterion 18).
export async function answerOf(questionId: string) {
  const [row] = await db
    .select()
    .from(agentQuestions)
    .where(eq(agentQuestions.id, questionId))
    .limit(1);
  // cm:guard keyed on `answeredAt` and NOT on the chosen option, because a free-text round is answered without one: the pre-ISS-996 filter reads every text answer as "not answered yet" and leaves the box parked on a question a person already settled.
  // cm:edge contract -> packages/runner/crates/forge-runner-core/src/transport/questions.rs — the box branches on `answerShape` and reads `optionId` or `text` accordingly; `optionId` stays present and null on a text answer rather than being dropped, so a box that predates the field still parses the payload and simply finds no option to act on.
  const answered = row?.steps.filter((s) => s.answeredAt).at(-1);
  if (!answered?.answeredAt) return null;
  const choice = isChoiceStep(answered);
  return {
    questionId,
    answerShape: (choice ? 'choice' : 'free_text') satisfies AnswerShape as AnswerShape,
    optionId: choice ? (answered.chosenOptionId ?? null) : null,
    text: choice ? null : (answered.answerText ?? null),
    answeredAt: answered.answeredAt,
    answeredBy: answered.answeredBy,
    round: answered.round,
  };
}

export async function registerWaiter(args: {
  questionId: string;
  deviceId: string;
  runId: string;
}) {
  await db.insert(questionWaiters).values(args).onConflictDoNothing();
}

export async function waitersOf(questionId: string) {
  return db.select().from(questionWaiters).where(eq(questionWaiters.questionId, questionId));
}

export async function waiterFor(args: { questionId: string; deviceId: string; runId: string }) {
  const [row] = await db
    .select()
    .from(questionWaiters)
    .where(
      and(
        eq(questionWaiters.questionId, args.questionId),
        eq(questionWaiters.deviceId, args.deviceId),
        eq(questionWaiters.runId, args.runId),
      ),
    )
    .limit(1);
  return row ?? null;
}
