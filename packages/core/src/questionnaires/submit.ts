// Submitting a questionnaire's answers.

import type { QuestionnaireAnswer, QuestionnaireItem } from '@forge/contracts/onboarding';
import { QUESTIONNAIRE_MACHINE } from '@forge/contracts/onboarding-machine';
import { QUESTION_MACHINE } from '@forge/contracts/question-machine';
import { eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { questionnaireBatches } from '../db/schema-onboarding.js';
import { agentQuestions, type QuestionStep } from '../db/schema-questions.js';
import { dataPolicyOf, storedAnswers } from '../lib/data-egress.js';
import { movedRow, transition } from '../lifecycle/index.js';
import { permissionFactsOf } from '../permissions/index.js';
import { appendMessagesIn, openOrExtendWindow, type TxOnly } from './ports.js';
import {
  type BatchRow,
  batchIn,
  batchView,
  type Executor,
  itemsOf,
  type StoredItem,
} from './read.js';
import { answerRefusals, batchReopensRoom, submitStateRefusal, submitterRefusal } from './rules.js';
import {
  announce,
  inTx,
  type QuestionnaireActor,
  type QuestionnaireOutcome,
  questionnaireKernelActor,
} from './service.js';
import { answersText } from './text.js';

function answeredStep(
  step: QuestionStep,
  item: QuestionnaireItem,
  a: QuestionnaireAnswer,
  by: string,
  at: string,
): QuestionStep {
  const stamp = { answeredAt: at, answeredBy: by };
  if (step.answerShape === 'free_text') return { ...step, ...stamp, answerText: a.text ?? '' };
  const chosen =
    item.control === 'accept_reject'
      ? a.decision
      : item.control === 'multi'
        ? a.choices?.[0]
        : a.choice;
  const choice = { ...step, ...stamp, chosenOptionId: chosen ?? '' };
  // cm:why a multi item keeps every pick beside the first; the step type names one chosen option
  return item.control === 'multi'
    ? ({ ...choice, chosenOptionIds: a.choices ?? [] } as QuestionStep)
    : choice;
}

interface SubmitInput {
  projectId: string;
  batchId: string;
  actor: QuestionnaireActor;
  answers: readonly QuestionnaireAnswer[];
  skip?: boolean | undefined;
  /** What the thread's owner writes in the same transaction: an onboarding goes back to the agent. */
  onSubmittedIn?: ((tx: TxOnly, batch: BatchRow, skipped: boolean) => Promise<void>) | undefined;
}

type ItemEntry = {
  item: StoredItem;
  open: boolean;
  row: Awaited<ReturnType<typeof itemsOf>>[number];
};
type Answer = SubmitInput['answers'][number];

/** Each given answer moves its item to `answered`; answers the map the answers message quotes. */
async function answerItems(
  tx: TxOnly,
  byId: Map<string, ItemEntry>,
  answers: readonly Answer[],
  input: SubmitInput,
  now: Date,
): Promise<Map<string, Omit<QuestionnaireAnswer, 'itemId'>>> {
  const at = now.toISOString();
  const given = new Map<string, Omit<QuestionnaireAnswer, 'itemId'>>();
  for (const a of answers) {
    const entry = byId.get(a.itemId);
    if (!entry) continue;
    const { itemId: _id, ...answer } = a;
    given.set(a.itemId, answer);
    const steps = entry.row.steps;
    const last = steps.at(-1);
    if (!last) throw new Error(`questionnaires: item ${a.itemId} has no step`);
    const answered = await transition(tx, QUESTION_MACHINE, {
      to: 'answered',
      expect: entry.row.status,
      set: {
        steps: [...steps.slice(0, -1), answeredStep(last, entry.item, a, input.actor.userId, at)],
        updatedAt: now,
      },
      where: eq(agentQuestions.id, entry.row.id),
      actor: questionnaireKernelActor(input.actor),
      source: 'questionnaire-submit',
      returning: ['id'],
    });
    movedRow(answered);
  }
  return given;
}

/**
 * The person's answers message. In a BA requirement room the answers are the person's turn: a
 * window opens on them, so the BA assistant answers as it would a typed message; an onboarding
 * thread hands back through a job instead.
 */
async function postAnswers(
  tx: TxOnly,
  batch: BatchRow,
  byId: Map<string, ItemEntry>,
  given: Map<string, Omit<QuestionnaireAnswer, 'itemId'>>,
  input: SubmitInput,
): Promise<string | null> {
  const items = [...byId.values()]
    .filter((e) => e.open)
    .sort((x, y) => x.item.position - y.item.position)
    .map((e) => e.item);
  const [message] = await appendMessagesIn(tx, {
    conversationId: batch.conversationId,
    messages: [
      {
        role: 'user',
        authorUserId: input.actor.userId,
        content: answersText({ title: batch.title, round: batch.round, items, answers: given }),
        blocks: [{ type: 'questionnaire_answers', batchId: batch.id }],
      },
    ],
  });
  if (batchReopensRoom(batch) && message) {
    await openOrExtendWindow(
      {
        conversationId: batch.conversationId,
        projectId: input.projectId,
        adapter: 'web',
        seq: message.seq,
      },
      tx as never,
    );
  }
  return message?.id ?? null;
}

/** The batch's own move, to `skipped` or `submitted`, then the thread owner's hook. */
async function settleBatch(
  tx: TxOnly,
  batch: BatchRow,
  input: SubmitInput,
  now: Date,
  messageId: string | null | undefined,
): Promise<void> {
  const skip = messageId === undefined;
  const moved = await transition(tx, QUESTIONNAIRE_MACHINE, {
    to: skip ? 'skipped' : 'submitted',
    expect: batch.status,
    set: skip
      ? { skippedBy: input.actor.userId, skippedAt: now }
      : { submittedBy: input.actor.userId, submittedAt: now, answersMessageId: messageId },
    where: eq(questionnaireBatches.id, batch.id),
    actor: questionnaireKernelActor(input.actor),
    source: 'questionnaire-submit',
    returning: ['id'],
  });
  movedRow(moved);
  await input.onSubmittedIn?.(tx, batch, skip);
}

// One submit for the whole batch (BC-7): every answer, the user's answers message and the batch's
// state land in one write or none does, and an unanswered item stays open.
export async function submitAnswers(input: SubmitInput): Promise<QuestionnaireOutcome> {
  const who = submitterRefusal(await permissionFactsOf(input.actor.userId, input.projectId));
  if (who) return { ok: false, refusals: [who] };
  const skip = input.skip === true;
  const answers = storedAnswers(await dataPolicyOf(input.projectId), input.answers);
  let conversationId = '';
  let messageId: string | null = null;
  const refused = await inTx(async (tx) => {
    const batch = await batchIn(tx, input.projectId, input.batchId, true);
    conversationId = batch.conversationId;
    const state = submitStateRefusal(batch, skip);
    if (state) return [state];
    if (skip && answers.length > 0) {
      return [
        {
          code: 'QUESTIONNAIRE_ANSWER_INVALID',
          path: '/skip',
          detail:
            'Skip for now sends no answers; send the answers without skip to answer some now.',
        },
      ];
    }
    const rows = await itemsOf(tx, [batch.id]);
    const byId = new Map<string, ItemEntry>(
      rows.map((r) => [
        (r.item as StoredItem).id,
        { item: r.item as StoredItem, open: r.status === 'open', row: r },
      ]),
    );
    const refusals = answerRefusals(byId, answers, skip);
    if (refusals.length) return refusals;
    const now = new Date();
    if (skip) {
      await settleBatch(tx, batch, input, now, undefined);
      return null;
    }
    const given = await answerItems(tx, byId, answers, input, now);
    messageId = await postAnswers(tx, batch, byId, given, input);
    await settleBatch(tx, batch, input, now, messageId);
    return null;
  });
  if (refused) return { ok: false, refusals: refused };
  await announce(conversationId, messageId, 'user');
  return {
    ok: true,
    questionnaire: await batchView(db as Executor, input.projectId, input.batchId),
  };
}
