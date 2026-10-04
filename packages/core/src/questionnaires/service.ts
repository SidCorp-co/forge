/**
 * Questionnaires (workflow project-onboarding rev 1, steps `ask` and `submitted`): a batch of items
 * posted as one structured message in a thread, answered once by a person. The onboarding thread
 * and a BA requirement room post through `postQuestionnaireIn`; both answer through
 * `submitAnswers`. Each write runs in one transaction and answers an outcome, refusals named and
 * nothing written. The guards are `rules.ts`, the reads `read.ts`.
 */

import type { QuestionnaireItem, QuestionnaireView } from '@forge/contracts/onboarding';
import { QUESTIONNAIRE_MACHINE } from '@forge/contracts/onboarding-machine';
import type { ActorAgency } from '@forge/contracts/permissions';
import { QUESTION_MACHINE } from '@forge/contracts/question-machine';
import { and, eq, inArray, isNull } from 'drizzle-orm';
import { db } from '../db/client.js';
import { conversations } from '../db/schema-conversations.js';
import { questionnaireBatches } from '../db/schema-onboarding.js';
import { agentQuestions, type QuestionOrigin, type QuestionStep } from '../db/schema-questions.js';
import { type Refusal, RefusalError } from '../lib/refusal.js';
import { type KernelActor, transition } from '../lifecycle/index.js';
import { insertBatchQuestions } from '../questions/index.js';
import {
  announceConversationChange,
  appendMessagesIn,
  handleForProject,
  type TxOnly,
} from './ports.js';
import { openBatchOf, priorAnswers, type StoredItem } from './read.js';
import { alreadyOpenRefusal, itemRefusals, repeatRefusals } from './rules.js';
import { questionnaireText } from './text.js';

export function questionnaireKernelActor(actor: QuestionnaireActor): KernelActor {
  return { type: 'user', id: actor.userId, agency: actor.agency };
}

export interface QuestionnaireActor {
  userId: string;
  agency: ActorAgency;
}

export type QuestionnaireOutcome =
  | { ok: true; questionnaire: QuestionnaireView; created?: boolean }
  | { ok: false; refusals: Refusal[] };

/** Runs `body` in a transaction; refusals it returns or throws roll everything back and come out. */
export async function inTx(
  body: (tx: TxOnly) => Promise<Refusal[] | null | undefined>,
): Promise<Refusal[] | null> {
  try {
    return await db.transaction(async (tx) => {
      const refusals = await body(tx);
      if (refusals?.length) throw new RefusalError(refusals, 'QUESTIONNAIRE_REFUSED');
      return null;
    });
  } catch (err) {
    if (err instanceof RefusalError) return [...err.refusals];
    throw err;
  }
}

/** Tells every reader of the room that it changed; the web refetches the thread on it. */
export async function announce(conversationId: string, messageId: string | null, role: string) {
  await announceConversationChange(conversationId, {
    conversationId,
    messageId,
    role,
    content: '',
  }).catch(() => 0);
}

function stepOf(item: QuestionnaireItem): QuestionStep {
  const common = { round: 1, prompt: item.prompt, askedAt: new Date().toISOString() };
  if (item.control === 'text') {
    return { ...common, answerShape: 'free_text', needed: item.placeholder ?? item.prompt };
  }
  const options =
    item.control === 'accept_reject'
      ? [
          { id: 'accept', label: 'Accept' },
          { id: 'reject', label: 'Reject' },
        ]
      : (item.options ?? []);
  return {
    ...common,
    answerShape: 'choice',
    options: options.map((o) => ({
      id: o.id,
      label: o.label,
      authority: 'writer' as const,
      bindsTo: 'this_call' as const,
      executedBy: 'agent' as const,
    })),
    // cm:why an inferred default is marked, never chosen: the row records it as the recommendation
    // and leaves chosenOptionId unset until a person picks
    recommendedOptionId: item.inferredDefault ?? '',
  };
}

interface PostInput {
  projectId: string;
  conversationId: string;
  onboardingId: string | null;
  requirementId: string | null;
  round: number;
  /** Items answered since this moment are not asked again (the series a re-analysis restarts). */
  seriesSince: Date;
  actor: QuestionnaireActor;
  authorLabel: string;
  title: string;
  intro?: string | undefined;
  items: readonly QuestionnaireItem[];
}

/** Posts one batch in the caller's transaction; the caller holds the thread's lock and checked who may. */
export async function postQuestionnaireIn(
  tx: TxOnly,
  input: PostInput,
): Promise<Refusal[] | { batchId: string; messageId: string }> {
  const shape = itemRefusals(input.items);
  if (shape.length) return shape;
  const open = await openBatchOf(tx, input.conversationId);
  const busy = alreadyOpenRefusal(open);
  if (busy) return [busy];
  const prior = await priorAnswers(tx, input.conversationId, input.seriesSince);
  const repeats = repeatRefusals(input.items, prior.answered, prior.rejected);
  if (repeats.length) return repeats;
  if (input.requirementId) {
    const [single] = await tx
      .select({ id: agentQuestions.id })
      .from(agentQuestions)
      .where(
        and(
          eq(agentQuestions.requirementId, input.requirementId),
          eq(agentQuestions.status, 'open'),
        ),
      )
      .limit(1);
    if (single) {
      return [
        {
          code: 'CLARIFICATION_ALREADY_OPEN',
          path: '',
          detail: `question ${single.id} is still open on this requirement; at most one ask is open per item (Q5), and a batch is one. Wait for its answer.`,
        },
      ];
    }
  }
  const [room] = await tx
    .select({ externalId: conversations.externalId, adapter: conversations.adapter })
    .from(conversations)
    .where(eq(conversations.id, input.conversationId));
  if (!room) throw new Error(`questionnaires: conversation ${input.conversationId} vanished`);

  const [batch] = await tx
    .insert(questionnaireBatches)
    .values({
      projectId: input.projectId,
      conversationId: input.conversationId,
      onboardingId: input.onboardingId,
      requirementId: input.requirementId,
      title: input.title,
      intro: input.intro ?? null,
      round: input.round,
      postedBy: input.actor.userId,
      postedAgency: input.actor.agency,
    })
    .returning({ id: questionnaireBatches.id });
  if (!batch) throw new Error('questionnaires: the batch insert returned no row');

  const author =
    (await handleForProject(input.conversationId, input.projectId, tx)) ?? input.actor.userId;
  const [message] = await appendMessagesIn(tx, {
    conversationId: input.conversationId,
    messages: [
      {
        role: 'assistant',
        authorUserId: author,
        authorLabel: input.authorLabel,
        content: questionnaireText(input),
        blocks: [{ type: 'questionnaire', batchId: batch.id }],
      },
    ],
  });
  if (!message) throw new Error('questionnaires: the message insert returned no row');

  const origin: QuestionOrigin = {
    kind: 'conversation',
    adapter: room.adapter,
    venueId: room.externalId,
    conversationId: input.conversationId,
    windowId: null,
    anchorId: message.id,
    askedByUserId: input.actor.userId,
    askedByLabel: input.authorLabel,
    askedByKey: null,
  };
  await insertBatchQuestions(
    tx,
    input.items.map((item, position) => ({
      id: crypto.randomUUID(),
      projectId: input.projectId,
      batchId: batch.id,
      item: { ...item, position } satisfies StoredItem,
      blockerKind: 'human' as const,
      steps: [stepOf(item)],
      maxRounds: 1,
      origin,
    })),
  );
  await tx
    .update(questionnaireBatches)
    .set({ messageId: message.id })
    .where(eq(questionnaireBatches.id, batch.id));
  // cm:why what stayed open in an answered batch is asked again here or not at all: its rows close
  // as carried, so no decision is open twice
  const answeredBefore = await tx
    .select({ id: questionnaireBatches.id })
    .from(questionnaireBatches)
    .where(
      and(
        eq(questionnaireBatches.conversationId, input.conversationId),
        eq(questionnaireBatches.status, 'submitted'),
      ),
    );
  if (answeredBefore.length) {
    const why = `carried into questionnaire ${batch.id}`;
    await transition(tx, QUESTION_MACHINE, {
      to: 'void',
      from: 'open',
      set: { voidReason: why, updatedAt: new Date() },
      where: inArray(
        agentQuestions.batchId,
        answeredBefore.map((b) => b.id),
      ),
      reason: why,
      actor: questionnaireKernelActor(input.actor),
      source: 'questionnaire',
      returning: ['id'],
    });
  }
  // cm:why an answer to a superseded batch is refused naming the batch that replaced it: the next
  // batch posted in the thread is that replacement
  await tx
    .update(questionnaireBatches)
    .set({ supersededBy: batch.id })
    .where(
      and(
        eq(questionnaireBatches.conversationId, input.conversationId),
        eq(questionnaireBatches.status, 'superseded'),
        isNull(questionnaireBatches.supersededBy),
      ),
    );
  return { batchId: batch.id, messageId: message.id };
}

/** Supersedes every open or skipped batch of an onboarding, voiding their open items. */
export async function supersedeOpenIn(tx: TxOnly, onboardingId: string, reason: string) {
  const { rows: open } = await transition(tx, QUESTIONNAIRE_MACHINE, {
    to: 'superseded',
    from: ['open', 'skipped'],
    set: { supersededAt: new Date(), supersededReason: reason },
    where: eq(questionnaireBatches.onboardingId, onboardingId),
    reason,
    actor: { type: 'system' },
    source: 'questionnaire-supersede',
    returning: ['id'],
  });
  if (open.length === 0) return [];
  await transition(tx, QUESTION_MACHINE, {
    to: 'void',
    from: 'open',
    set: { voidReason: reason, updatedAt: new Date() },
    where: inArray(
      agentQuestions.batchId,
      open.map((b) => b.id),
    ),
    reason,
    actor: { type: 'system' },
    source: 'questionnaire-supersede',
    returning: ['id'],
  });
  return open.map((b) => b.id);
}
