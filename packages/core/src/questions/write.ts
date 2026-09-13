// Everything that changes a question, and every refusal that keeps its shape.
//
// A question is refused at WRITE time or not at all. The other end of this is a
// runner on a box that compiles against none of these types, so a shape held
// only by TypeScript is a shape held nowhere (ISS-964 criteria 14, 16, 21).

import { and, eq, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { issues, type ProjectMemberRole } from '../db/schema.js';
import {
  type AnswerShape,
  agentQuestions,
  type ChoiceStep,
  isChoiceStep,
  type QuestionBlockerKind,
  type QuestionOption,
  type QuestionStep,
} from '../db/schema-questions.js';
import type { IssueDependencyExecutor } from '../issues/dependency-executor.js';
import { hooks } from '../pipeline/hooks.js';
import { wakeMastersForAnswer } from '../ws/master-wake.js';

// cm:guard the shape is DECLARED by the asker, never derived from which field arrived. A caller that sends an option list and a needed-text line has asked two questions in one round, and deriving would silently pick one of them for the person to answer (ISS-996).
/** The pool, or a caller's open transaction — a park writes its question inside the transition's. */
type QuestionExecutor = IssueDependencyExecutor;

export type AskAnswer =
  | { shape: 'choice'; options: QuestionOption[]; recommendedOptionId: string }
  | { shape: 'free_text'; needed: string };

export type AskInput = {
  id: string;
  projectId: string;
  issueId?: string;
  agentSessionId?: string;
  prompt: string;
  blockerKind: QuestionBlockerKind;
  answer: AskAnswer;
  assumed?: Record<string, unknown>;
  cost?: { claimsHeld?: number; workspacesPinned?: number; dependents?: number };
  maxRounds?: number;
  parkDeadlineAt?: Date;
};

// cm:guard the `code` is the machine-readable half a surface acts on and it must stay distinct per refusal — web-v2's `formatApiError` replaces a generic `FORBIDDEN` with "You do not have access to this resource", so a stale round or an already-answered question routed through that code reaches the person as a sentence about permissions.
export class QuestionRefused extends Error {
  readonly code: QuestionRefusalCode;
  constructor(message: string, code: QuestionRefusalCode = 'QUESTION_REFUSED') {
    super(message);
    this.code = code;
  }
}

export const questionRefusalCodes = [
  'QUESTION_REFUSED',
  'QUESTION_NOT_FOUND',
  'QUESTION_NOT_OPEN',
  'QUESTION_EXPIRED',
  'QUESTION_ROUND_STALE',
  'QUESTION_OPTION_UNKNOWN',
  'QUESTION_AUTHORITY_REQUIRED',
  'QUESTION_REASON_REQUIRED',
  'QUESTION_ISSUE_ELSEWHERE',
  'QUESTION_OPTIONS_REQUIRED',
  'QUESTION_RECOMMENDED_UNKNOWN',
  'QUESTION_OPTION_IDS_DUPLICATE',
  'QUESTION_SHAPE_INVALID',
  'QUESTION_ANSWER_WRONG_SHAPE',
] as const;
export type QuestionRefusalCode = (typeof questionRefusalCodes)[number];

// cm:guard test what the role IS, never what it is not. `effectiveProjectRole` answers `{ role: null }` — not `null` — for a signed-in caller who belongs to neither the project nor the org that owns it, so the earlier "anything but viewer" form let a stranger choose every `authority: 'writer'` option in the fleet (ISS-980).
// cm:guard this is the ONE implementation of choosability; `questions/read.ts` imports it for the `locked` flag rather than restating the rule, because two authorities disagreeing is how a lock becomes decorative (ISS-964 criterion 15).
export function mayChoose(option: QuestionOption, role: ProjectMemberRole | null): boolean {
  if (role === 'admin') return true;
  if (role === 'member') return option.authority === 'writer';
  return false;
}

// cm:guard these three refusals carry codes of their OWN and must keep them: they are malformed BODIES, and the generic `QUESTION_REFUSED` is mapped to 403 in `routes.ts`, which tells a caller whose options array is empty to go and ask somebody for access.
// cm:guard `binds_to: this_call` REQUIRES a fingerprint, and that pair is the whole of the permission shape — there is no `kind` column saying an option is a permission. An option that binds to one call without naming it is a standing allowance wearing the label of a single decision (ISS-964 criteria 13, 16).
function checkOptions(options: QuestionOption[], recommendedOptionId: string) {
  if (options.length === 0) {
    throw new QuestionRefused(
      'a question with no options is not a question',
      'QUESTION_OPTIONS_REQUIRED',
    );
  }
  // cm:guard option ids are UNIQUE within a round, because every reader resolves one by `find` and takes the first: two options sharing an id leave `chosenOptionId` naming a decision nobody can recover, and `checkPermission` reads the authority and fingerprint of whichever was listed first rather than the one the person picked.
  if (new Set(options.map((o) => o.id)).size !== options.length) {
    throw new QuestionRefused(
      'two options on this round carry the same id — an answer names an option by id, so a repeated one records a choice nobody can read back',
      'QUESTION_OPTION_IDS_DUPLICATE',
    );
  }
  for (const o of options) {
    if (o.bindsTo === 'this_call' && !o.fingerprint?.trim()) {
      throw new QuestionRefused(
        `option ${o.id} binds to one call and carries no fingerprint of it — a permission that names no call allows the next call instead of the blocked one`,
      );
    }
  }
  if (!recommendedOptionId || !options.some((o) => o.id === recommendedOptionId)) {
    throw new QuestionRefused(
      'every question carries a recommended option, and it must be one of this question own options — a human facing a queue owes a click, not a decision',
      'QUESTION_RECOMMENDED_UNKNOWN',
    );
  }
}

// cm:guard every refusal a shape can raise is thrown HERE, at the ask, and none of them is re-checked when the answer arrives: a round already put to a person cannot be withdrawn for being malformed, so a shape that reaches the room has already been accepted (ISS-996).
export function checkAnswer(answer: AskAnswer): void {
  if (answer.shape === 'choice') {
    checkOptions(answer.options, answer.recommendedOptionId);
    return;
  }
  if (!answer.needed.trim()) {
    throw new QuestionRefused(
      'a free-text round states what would settle it — the credential, the missing paragraph, which reading was meant. Without that the person is asked to guess what counts as an answer',
      'QUESTION_SHAPE_INVALID',
    );
  }
}

function step(round: number, prompt: string, answer: AskAnswer): QuestionStep {
  const askedAt = new Date().toISOString();
  return answer.shape === 'choice'
    ? {
        round,
        prompt,
        askedAt,
        answerShape: 'choice',
        options: answer.options,
        recommendedOptionId: answer.recommendedOptionId,
      }
    : { round, prompt, askedAt, answerShape: 'free_text', needed: answer.needed };
}

// cm:guard the issue must belong to the project the question names, and the refusal is here because a row whose two columns disagree is unreachable by every reader downstream: the issue-scoped list, the attention bucket's cost subqueries and `answerReachesAParkedRun` all reach a question through one column or the other, and each narrowing that excludes the crossed row silently excludes it from something a person or a parked run needed (ISS-989). Refused by name rather than absorbed, because no reader can tell which of the two columns the caller meant.
// cm:guard ONE code for both faults on purpose, against the per-refusal rule above: a missing issue and an issue of another project are the same fault to the caller — the `issueId` you sent is not an issue of this project — and the caller's remedy is identical. The messages differentiate for a person reading them; the code is what a box branches on, and it has one branch. (The missing-issue case used to raise a foreign-key 500.)
async function checkIssueBelongsToProject(
  issueId: string | undefined,
  projectId: string,
): Promise<void> {
  if (!issueId) return;
  const [issue] = await db
    .select({ projectId: issues.projectId })
    .from(issues)
    .where(eq(issues.id, issueId))
    .limit(1);
  if (!issue) {
    throw new QuestionRefused(`no issue ${issueId}`, 'QUESTION_ISSUE_ELSEWHERE');
  }
  if (issue.projectId !== projectId) {
    throw new QuestionRefused(
      `issue ${issueId} belongs to project ${issue.projectId}, not to ${projectId} — ask it under the issue's own project`,
      'QUESTION_ISSUE_ELSEWHERE',
    );
  }
}

export async function askQuestion(input: AskInput) {
  checkAnswer(input.answer);
  await checkIssueBelongsToProject(input.issueId, input.projectId);
  return insertQuestion(db, input);
}

/**
 * The question a park mints, written inside the transition's own transaction.
 */
// cm:guard core ALLOCATES the id here, and that does not weaken the rule on the pool route that it must not: a box asking through `POST /me/questions` has already written its own half of the park in a local transaction, and this door has no such half — the park and its question are one commit or neither (ISS-996).
// cm:guard no `checkIssueBelongsToProject` call: the caller is mid-transition on that very issue and holds its `projectId`, so the crossed row this guards against is not representable here, and the read would be a `issues` SELECT inside the highest-volume transaction in the product (ISS-863's rule).
export async function askParkQuestion(
  executor: QuestionExecutor,
  input: { id: string; projectId: string; issueId: string; prompt: string; needed: string },
) {
  const answer: AskAnswer = { shape: 'free_text', needed: input.needed };
  checkAnswer(answer);
  return insertQuestion(executor, {
    id: input.id,
    projectId: input.projectId,
    issueId: input.issueId,
    prompt: input.prompt,
    blockerKind: 'human',
    answer,
  });
}

async function insertQuestion(executor: QuestionExecutor, input: AskInput) {
  const [row] = await executor
    .insert(agentQuestions)
    .values({
      id: input.id,
      projectId: input.projectId,
      issueId: input.issueId,
      agentSessionId: input.agentSessionId,
      blockerKind: input.blockerKind,
      steps: [step(1, input.prompt, input.answer)],
      assumed: input.assumed,
      maxRounds: input.maxRounds ?? 3,
      claimsHeld: input.cost?.claimsHeld ?? 0,
      workspacesPinned: input.cost?.workspacesPinned ?? 0,
      dependents: input.cost?.dependents ?? 0,
      parkDeadlineAt: input.parkDeadlineAt,
    })
    .returning();
  if (!row) throw new QuestionRefused('the question was not written');
  return view(row);
}

export async function getQuestion(id: string) {
  const [row] = await db.select().from(agentQuestions).where(eq(agentQuestions.id, id)).limit(1);
  return row ? view(row) : null;
}

export async function openQuestionCount(projectId: string) {
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(agentQuestions)
    .where(and(eq(agentQuestions.projectId, projectId), eq(agentQuestions.status, 'open')));
  return row?.n ?? 0;
}

// cm:guard the answer names its own shape, and a mismatch is refused rather than coerced: text handed to a choice round must never be resolved to the nearest option, and an option id handed to a free-text round must never be stored as its text. Guessing which option somebody meant is the one failure a locked option and a fingerprint exist to prevent (ISS-978 criterion 18), and it does not become acceptable because the guess would be easy.
export type GivenAnswer = { kind: 'option'; optionId: string } | { kind: 'text'; text: string };

export type AnswerInput = {
  questionId: string;
  answer: GivenAnswer;
  /** The round the answerer was looking at. Never defaulted to the current one. */
  round: number;
  by: string;
  role: ProjectMemberRole | null;
};

// cm:guard ANY role on the project may answer in words, viewer included — the owner's call on 2026-09-13, and it is not the same question `mayChoose` answers. An OPTION declares its own authority because choosing one exercises it; writing an answer supplies information the run asked for, and gating that on a role only means the person who has it gets asked to relay what the person who does not already typed. A `null` role is still refused, by `answerAs` reading the question at all.
export function mayAnswerFreeText(role: ProjectMemberRole | null): boolean {
  return role !== null;
}

/**
 * Record one answer, or refuse and leave the row exactly as it was.
 */
// cm:guard ONE transaction and the row taken `FOR UPDATE` before any check, because a status check performed before an unconditional update is not a check: the pre-ISS-980 form read, validated and then wrote `status: 'answered'` with `where(eq(id))` alone, so it overwrote an existing answer and resurrected a `void` or `expired` row. Every predicate below must read the LOCKED row, and the write must go through `tx`.
// cm:guard the clock is sampled AFTER the lock is granted, never before: a caller that waited on the lock while the park deadline passed must be refused by the deadline it actually crossed, not by the one it saw when it queued.
// cm:guard nothing here mutates `row.steps` in place — the answered step is a copy — so a refusal thrown below leaves the caller's loaded row as untouched as the database row (criterion 35).
export async function answerQuestion(args: AnswerInput) {
  const committed = await db.transaction(async (tx) => {
    const [row] = await tx
      .select()
      .from(agentQuestions)
      .where(eq(agentQuestions.id, args.questionId))
      .limit(1)
      .for('update');
    if (!row) throw new QuestionRefused(`no question ${args.questionId}`, 'QUESTION_NOT_FOUND');
    const now = new Date();
    if (row.status !== 'open') {
      throw new QuestionRefused(
        `this question is ${row.status} — only an open question takes an answer`,
        'QUESTION_NOT_OPEN',
      );
    }
    if (row.parkDeadlineAt && row.parkDeadlineAt.getTime() <= now.getTime()) {
      throw new QuestionRefused(
        `this question's park deadline passed at ${row.parkDeadlineAt.toISOString()}`,
        'QUESTION_EXPIRED',
      );
    }
    const current = row.steps[row.steps.length - 1];
    if (!current) throw new QuestionRefused('this question has no round to answer');
    if (current.round !== args.round) {
      throw new QuestionRefused(
        `this answer names round ${args.round} and the question is on round ${current.round} — the round you were shown has been superseded`,
        'QUESTION_ROUND_STALE',
      );
    }
    const choice = isChoiceStep(current);
    if (choice !== (args.answer.kind === 'option')) {
      throw new QuestionRefused(
        choice
          ? `round ${current.round} offers options and this answer carries text — reply with the number of the option you mean`
          : `round ${current.round} asks for text and this answer names an option — it has none to name`,
        'QUESTION_ANSWER_WRONG_SHAPE',
      );
    }
    let answered: QuestionStep;
    if (isChoiceStep(current) && args.answer.kind === 'option') {
      const optionId = args.answer.optionId;
      const option = current.options.find((o) => o.id === optionId);
      if (!option) {
        throw new QuestionRefused(
          `option ${optionId} is not on round ${current.round} of this question`,
          'QUESTION_OPTION_UNKNOWN',
        );
      }
      if (!mayChoose(option, args.role)) {
        throw new QuestionRefused(
          `option ${option.id} carries authority ${option.authority} and this caller may not choose it`,
          'QUESTION_AUTHORITY_REQUIRED',
        );
      }
      answered = {
        ...current,
        answeredAt: now.toISOString(),
        chosenOptionId: option.id,
        answeredBy: args.by,
      };
    } else if (!isChoiceStep(current) && args.answer.kind === 'text') {
      const text = args.answer.text.trim();
      // cm:guard an empty answer is refused as a SHAPE fault and never written as one: a round marked answered carrying nothing tells the parked run its question was settled and hands it the empty string as the settlement (ISS-996).
      if (!text) {
        throw new QuestionRefused(
          `round ${current.round} asks for text and this answer carries none`,
          'QUESTION_ANSWER_WRONG_SHAPE',
        );
      }
      if (!mayAnswerFreeText(args.role)) {
        throw new QuestionRefused(
          'answering a free-text round writes into a running agent and needs a role that may write on this project',
          'QUESTION_AUTHORITY_REQUIRED',
        );
      }
      answered = {
        ...current,
        answeredAt: now.toISOString(),
        answerText: text,
        answeredBy: args.by,
      };
    } else {
      throw new QuestionRefused(
        `round ${current.round} and this answer do not name the same shape`,
        'QUESTION_ANSWER_WRONG_SHAPE',
      );
    }
    const steps = row.steps.map((s, i) => (i === row.steps.length - 1 ? answered : s));
    await tx
      .update(agentQuestions)
      .set({ steps, status: 'answered', updatedAt: now })
      .where(eq(agentQuestions.id, args.questionId));
    return { ...row, steps, status: 'answered' as const };
  });
  // cm:guard emitted after the transaction RESOLVES, for the same reason the wake below is: a subscriber that resumes the issue on an answer a rejected commit never left would dispatch against a question still open (ISS-996).
  // cm:guard AWAITED, unlike the wake below, and the difference is what each one does. The wake only decides whether a box reads the answer now or on its next sweep; this one IS the resume, and firing it unawaited both hides its failure from the caller and races the answer's own transaction — measured as a deadlock between the subscriber's read and the transition it goes on to make. `comments/routes.ts` awaits `commentCreated` for the same reason.
  // cm:edge contract -> packages/core/src/pipeline/answer-resume.ts — that subscriber is what makes a core-minted park question resumable at all. A question the runner minted registers a waiter and the box comes back for it; a park's question has no box on the other end, so the answer reaches the work through this event or not at all.
  await hooks.emit('questionAnswered', {
    questionId: args.questionId,
    projectId: committed.projectId,
    issueId: committed.issueId ?? null,
    answeredBy: args.by,
    body: answeredBody(committed.steps.at(-1)),
  });
  // cm:guard published after the transaction RESOLVES — not merely after the statement inside it — and never awaited for its result, because the answer is already on the record: the box reads it back through `GET /me/questions/:id`, so this wake only decides whether that read happens now or on the next 30s sweep. A wake published from inside the transaction sends a box to read an answer a rejected commit never left (ISS-964 criteria 12, 44).
  void wakeMastersForAnswer({ projectId: committed.projectId, questionId: args.questionId });
  return view(committed);
}

// cm:guard a follow-up is a STEP on the same row, never a second row. Two rows for one chain is two entries in a queue ordered by the cost of blocking, and the cost is a property of the decision rather than of how many times the agent had to come back (ISS-964 criterion 20).
export async function askFollowUp(args: { questionId: string; prompt: string; answer: AskAnswer }) {
  const row = await load(args.questionId);
  checkAnswer(args.answer);
  if (row.steps.length >= row.maxRounds) {
    // cm:guard the thread becomes the record and the round is NOT asked. A fourth question is the same conversation wearing a new row, and the human who could not settle it in three is owed the whole thread rather than one more prompt (ISS-964 criterion 21).
    await db
      .update(agentQuestions)
      .set({ status: 'needs_info', updatedAt: new Date() })
      .where(eq(agentQuestions.id, args.questionId));
    throw new QuestionRefused(
      `max_rounds ${row.maxRounds} reached — the thread is the record now, and this question is needs_info`,
    );
  }
  const steps = [...row.steps, step(row.steps.length + 1, args.prompt, args.answer)];
  await db
    .update(agentQuestions)
    .set({ steps, status: 'open', updatedAt: new Date() })
    .where(eq(agentQuestions.id, args.questionId));
  return view({ ...row, steps, status: 'open' as const });
}

export async function voidQuestion(args: { questionId: string; reason: string }) {
  if (!args.reason?.trim()) {
    throw new QuestionRefused(
      'a question is voided WITH a reason — removed silently it is indistinguishable from one nobody answered',
      'QUESTION_REASON_REQUIRED',
    );
  }
  await db
    .update(agentQuestions)
    .set({ status: 'void', voidReason: args.reason, updatedAt: new Date() })
    .where(eq(agentQuestions.id, args.questionId));
}

/**
 * Does the answer on this question cover the call about to be made?
 */
// cm:guard REFUSE by name on a mismatch rather than answering false. A `false` here reads to the caller as "not allowed yet" and sends it back to ask again; the fault is that a permission for one call was presented for another, and only a named refusal says so (ISS-964 criterion 16).
export async function checkPermission(args: { questionId: string; fingerprint: string }) {
  const row = await load(args.questionId);
  // cm:guard a permission is a CHOSEN OPTION and a free-text round can never carry one, so this walks the choice rounds alone: reading the latest answered round of any shape would hand a text answer to a fingerprint comparison that no text can pass, and refuse the call with a message about a mismatch that never happened (ISS-996).
  const answered = row.steps.filter((s) => isChoiceStep(s) && s.chosenOptionId).at(-1) as
    | ChoiceStep
    | undefined;
  const chosen = answered?.options.find((o) => o.id === answered.chosenOptionId);
  if (!chosen) throw new QuestionRefused('this question carries no answer to check');
  if (chosen.bindsTo !== 'this_call') return true;
  if (chosen.fingerprint !== args.fingerprint) {
    throw new QuestionRefused(
      `fingerprint mismatch: this permission was given for \`${chosen.fingerprint}\` and is being presented for \`${args.fingerprint}\``,
    );
  }
  return true;
}

async function load(id: string) {
  const [row] = await db.select().from(agentQuestions).where(eq(agentQuestions.id, id)).limit(1);
  if (!row) throw new QuestionRefused(`no question ${id}`);
  return row;
}

// cm:guard the option's LABEL and not its id: this string is handed to a parked agent as the human's answer, and an id it never printed tells it nothing about what was chosen.
function answeredBody(step: QuestionStep | undefined): string {
  if (!step) return '';
  if (!isChoiceStep(step)) return step.answerText ?? '';
  return step.options.find((o) => o.id === step.chosenOptionId)?.label ?? '';
}

function view<T extends { steps: QuestionStep[] }>(row: T) {
  const current = row.steps[row.steps.length - 1];
  return {
    ...row,
    answerShape: (current && !isChoiceStep(current) ? 'free_text' : 'choice') as AnswerShape,
    recommendedOptionId: current && isChoiceStep(current) ? current.recommendedOptionId : '',
  };
}
