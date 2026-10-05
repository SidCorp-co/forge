// Answering a question: who may, with what, and what the answer resumes.

import type { PersonVia } from '@forge/contracts/ecosystem';
import type { ActorAgency } from '@forge/contracts/permissions';
import { QUESTION_MACHINE } from '@forge/contracts/question-machine';
import { eq } from 'drizzle-orm';
import { db, type Tx } from '../db/client.js';
import { agentQuestions, isChoiceStep, type QuestionStep } from '../db/schema-questions.js';
import { transition } from '../lifecycle/index.js';
import { notFound } from '../middleware/route-errors.js';
import { emitEvent } from '../outbox/index.js';
import { holds, type PermissionFacts, requireHeld } from '../permissions/index.js';
import { decideChannelGate, wakeMastersForAnswer } from './ports.js';
import { answeredBody, optionPermission, refuseQuestion, view } from './write.js';

export type GivenAnswer = { kind: 'option'; optionId: string } | { kind: 'text'; text: string };

export type AnswerInput = {
  questionId: string;
  answer: GivenAnswer;
  /** The round the answerer was looking at. Never defaulted to the current one. */
  round: number;
  by: string;
  /** Recorded on the move; who may answer is `facts`'s. */
  agency: ActorAgency;
  facts: PermissionFacts;
  note?: string;
  /** The door the answerer came through, which a channel gate records as the decider's via. */
  via: PersonVia;
};

export function mayAnswerFreeText(facts: PermissionFacts | null): boolean {
  return facts !== null && holds(facts, 'project.write');
}

type QuestionRow = typeof agentQuestions.$inferSelect;

/** The row-level refusals: not answerable here, not open, past its deadline, a note it cannot
 *  carry, a stale round, or an answer of the wrong shape. Answers the round being answered. */
function refuseAnswerTo(row: QuestionRow, args: AnswerInput, now: Date): QuestionStep {
  if (row.batchId) {
    throw refuseQuestion(
      'QUESTION_IN_QUESTIONNAIRE',
      `question ${row.id} is an item of questionnaire ${row.batchId}; answer it with its batch (POST …/questionnaires/${row.batchId}/answers)`,
    );
  }
  if (row.status !== 'open') {
    throw refuseQuestion(
      'QUESTION_NOT_OPEN',
      `this question is ${row.status} — only an open question takes an answer`,
    );
  }
  if (row.parkDeadlineAt && row.parkDeadlineAt.getTime() <= now.getTime()) {
    throw refuseQuestion(
      'QUESTION_EXPIRED',
      `this question's park deadline passed at ${row.parkDeadlineAt.toISOString()}`,
    );
  }
  const current = row.steps[row.steps.length - 1];
  if (!current) throw new Error(`question ${row.id} has no round to answer`);
  if (args.note !== undefined && row.origin?.kind !== 'channel_gate') {
    throw refuseQuestion(
      'QUESTION_NOTE_NOT_TAKEN',
      'a note travels only with an answer that carries it somewhere, and this question carries none — a channel gate takes one; here, answer with the option alone',
    );
  }
  if (current.round !== args.round) {
    throw refuseQuestion(
      'QUESTION_ROUND_STALE',
      `this answer names round ${args.round} and the question is on round ${current.round} — the round you were shown has been superseded`,
    );
  }
  const choice = isChoiceStep(current);
  if (choice !== (args.answer.kind === 'option')) {
    throw refuseQuestion(
      'QUESTION_ANSWER_WRONG_SHAPE',
      choice
        ? `round ${current.round} offers options and this answer carries text — reply with the number of the option you mean`
        : `round ${current.round} asks for text and this answer names an option — it has none to name`,
    );
  }
  return current;
}

/** The answered round; a channel gate's question decides its gate in the answer's transaction. */
async function answerRound(
  tx: Tx,
  row: QuestionRow,
  current: QuestionStep,
  args: AnswerInput,
  now: Date,
): Promise<QuestionStep> {
  const note = args.note?.trim() || undefined;
  if (isChoiceStep(current) && args.answer.kind === 'option') {
    const optionId = args.answer.optionId;
    const option = current.options.find((o) => o.id === optionId);
    if (!option) {
      throw refuseQuestion(
        'QUESTION_OPTION_UNKNOWN',
        `option ${optionId} is not on round ${current.round} of this question`,
      );
    }
    requireHeld(args.facts, optionPermission(option), `choosing option ${option.id}`);
    if (row.origin?.kind === 'channel_gate') {
      await decideChannelGate(tx, {
        documentId: row.origin.documentId,
        projectId: row.projectId,
        optionId: option.id,
        note,
        by: args.by,
        via: args.via,
      });
    }
    return {
      ...current,
      answeredAt: now.toISOString(),
      chosenOptionId: option.id,
      answeredBy: args.by,
      ...(note ? { note } : {}),
    };
  }
  if (!isChoiceStep(current) && args.answer.kind === 'text') {
    const text = args.answer.text.trim();
    if (!text) {
      throw refuseQuestion(
        'QUESTION_ANSWER_WRONG_SHAPE',
        `round ${current.round} asks for text and this answer carries none`,
      );
    }
    requireHeld(args.facts, 'project.write', 'answering a free-text round');
    return {
      ...current,
      answeredAt: now.toISOString(),
      answerText: text,
      answeredBy: args.by,
    };
  }
  throw refuseQuestion(
    'QUESTION_ANSWER_WRONG_SHAPE',
    `round ${current.round} and this answer do not name the same shape`,
  );
}

/**
 * Record one answer, or refuse and leave the row exactly as it was.
 */
export async function answerQuestion(args: AnswerInput) {
  const committed = await db.transaction(async (tx) => {
    const [row] = await tx
      .select()
      .from(agentQuestions)
      .where(eq(agentQuestions.id, args.questionId))
      .limit(1)
      .for('update');
    if (!row) throw notFound(`no question ${args.questionId}`);
    const now = new Date();
    const current = refuseAnswerTo(row, args, now);
    const answered = await answerRound(tx, row, current, args, now);
    const steps = row.steps.map((s, i) => (i === row.steps.length - 1 ? answered : s));
    await transition(tx, QUESTION_MACHINE, {
      to: 'answered',
      from: 'open',
      set: { steps, updatedAt: now },
      where: eq(agentQuestions.id, args.questionId),
      actor: { type: 'user', id: args.by, agency: args.agency },
      source: 'questions',
      returning: ['id'],
    });
    await emitEvent(tx, 'question.answered', {
      questionId: args.questionId,
      projectId: row.projectId,
      issueId: row.issueId ?? null,
      answeredBy: args.by,
      body: answeredBody(answered),
    });
    return { ...row, steps, status: 'answered' as const };
  });
  void wakeMastersForAnswer({ projectId: committed.projectId, questionId: args.questionId });
  return view(committed);
}
