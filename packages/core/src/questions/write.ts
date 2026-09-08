// Everything that changes a question, and every refusal that keeps its shape.
//
// A question is refused at WRITE time or not at all. The other end of this is a
// runner on a box that compiles against none of these types, so a shape held
// only by TypeScript is a shape held nowhere (ISS-964 criteria 14, 16, 21).

import { and, eq, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import {
  agentQuestions,
  type QuestionBlockerKind,
  type QuestionOption,
  type QuestionStep,
} from '../db/schema-questions.js';

export type AskInput = {
  id: string;
  projectId: string;
  issueId?: string;
  agentSessionId?: string;
  prompt: string;
  blockerKind: QuestionBlockerKind;
  options: QuestionOption[];
  recommendedOptionId: string;
  assumed?: Record<string, unknown>;
  cost?: { claimsHeld?: number; workspacesPinned?: number; dependents?: number };
  maxRounds?: number;
  parkDeadlineAt?: Date;
};

export class QuestionRefused extends Error {}

// cm:guard `binds_to: this_call` REQUIRES a fingerprint, and that pair is the whole of the permission shape — there is no `kind` column saying an option is a permission. An option that binds to one call without naming it is a standing allowance wearing the label of a single decision (ISS-964 criteria 13, 16).
function checkOptions(options: QuestionOption[], recommendedOptionId: string) {
  if (options.length === 0)
    throw new QuestionRefused('a question with no options is not a question');
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
    );
  }
}

function step(
  round: number,
  prompt: string,
  options: QuestionOption[],
  recommendedOptionId: string,
): QuestionStep {
  return { round, prompt, options, recommendedOptionId, askedAt: new Date().toISOString() };
}

export async function askQuestion(input: AskInput) {
  checkOptions(input.options, input.recommendedOptionId);
  const [row] = await db
    .insert(agentQuestions)
    .values({
      id: input.id,
      projectId: input.projectId,
      issueId: input.issueId,
      agentSessionId: input.agentSessionId,
      blockerKind: input.blockerKind,
      steps: [step(1, input.prompt, input.options, input.recommendedOptionId)],
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

export async function answerQuestion(args: { questionId: string; optionId: string; by: string }) {
  const row = await load(args.questionId);
  const steps = row.steps;
  const current = steps[steps.length - 1];
  if (!current) throw new QuestionRefused('this question has no round to answer');
  if (!current.options.some((o) => o.id === args.optionId)) {
    throw new QuestionRefused(`option ${args.optionId} is not on the open round of this question`);
  }
  current.answeredAt = new Date().toISOString();
  current.chosenOptionId = args.optionId;
  current.answeredBy = args.by;
  await db
    .update(agentQuestions)
    .set({ steps, status: 'answered', updatedAt: new Date() })
    .where(eq(agentQuestions.id, args.questionId));
  return view({ ...row, steps, status: 'answered' as const });
}

// cm:guard a follow-up is a STEP on the same row, never a second row. Two rows for one chain is two entries in a queue ordered by the cost of blocking, and the cost is a property of the decision rather than of how many times the agent had to come back (ISS-964 criterion 20).
export async function askFollowUp(args: {
  questionId: string;
  prompt: string;
  options: QuestionOption[];
  recommendedOptionId?: string;
}) {
  const row = await load(args.questionId);
  const recommendedOptionId = args.recommendedOptionId ?? args.options[0]?.id ?? '';
  checkOptions(args.options, recommendedOptionId);
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
  const steps = [
    ...row.steps,
    step(row.steps.length + 1, args.prompt, args.options, recommendedOptionId),
  ];
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
  const answered = row.steps.filter((s) => s.chosenOptionId).at(-1);
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

function view<T extends { steps: QuestionStep[] }>(row: T) {
  return {
    ...row,
    recommendedOptionId: row.steps[row.steps.length - 1]?.recommendedOptionId ?? '',
  };
}
