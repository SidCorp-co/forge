/**
 * Questionnaires (workflow project-onboarding rev 1, steps `ask` and `submitted`): a batch of items
 * posted as one structured message in a thread, answered once by a person. The onboarding thread
 * and a BA requirement room post through `postQuestionnaireIn`; both answer through
 * `submitAnswers`. Each write runs in one transaction and answers an outcome, refusals named and
 * nothing written. The guards are `rules.ts`, the reads `read.ts`.
 */

import type {
  QuestionnaireAnswer,
  QuestionnaireItem,
  QuestionnaireView,
} from '@forge/contracts/onboarding';
import { and, eq, inArray, isNull } from 'drizzle-orm';
import {
  publishToConversationReaders,
  WEB_CONVERSATION_EVENT,
} from '../assistant/conversation-adapter.js';
import type { TxOnly } from '../conversations/db-executor.js';
import { handleForProject } from '../conversations/participants.js';
import { appendMessagesIn } from '../conversations/store.js';
import { openOrExtendWindow } from '../conversations/windows.js';
import { db } from '../db/client.js';
import { conversations } from '../db/schema-conversations.js';
import { questionnaireBatches } from '../db/schema-onboarding.js';
import { agentQuestions, type QuestionOrigin, type QuestionStep } from '../db/schema-questions.js';
import type { ActorAgency } from '../issues/actor-agency.js';
import { dataPolicyOf, storedAnswers } from '../lib/data-egress.js';
import { permissionFactsOf } from '../permissions/index.js';
import type { NamedRefusal } from '../project-config/respond.js';
import {
  type BatchRow,
  batchIn,
  batchView,
  type Executor,
  itemsOf,
  openBatchOf,
  priorAnswers,
  type StoredItem,
} from './read.js';
import {
  alreadyOpenRefusal,
  answerRefusals,
  itemRefusals,
  repeatRefusals,
  submitStateRefusal,
  submitterRefusal,
} from './rules.js';
import { answersText, questionnaireText } from './text.js';

export interface QuestionnaireActor {
  userId: string;
  agency: ActorAgency;
}

export type QuestionnaireOutcome =
  | { ok: true; questionnaire: QuestionnaireView; created?: boolean }
  | { ok: false; refusals: NamedRefusal[] };

export class Refused extends Error {
  constructor(readonly refusals: NamedRefusal[]) {
    super(refusals.map((r) => r.code).join(', '));
  }
}

/** Runs `body` in a transaction; refusals it returns or throws roll everything back and come out. */
export async function inTx(
  body: (tx: TxOnly) => Promise<NamedRefusal[] | null | undefined>,
): Promise<NamedRefusal[] | null> {
  try {
    return await db.transaction(async (tx) => {
      const refusals = await body(tx);
      if (refusals?.length) throw new Refused(refusals);
      return null;
    });
  } catch (err) {
    if (err instanceof Refused) return err.refusals;
    throw err;
  }
}

/** Tells every reader of the room that it changed; the web refetches the thread on it. */
export async function announce(conversationId: string, messageId: string | null, role: string) {
  await publishToConversationReaders(conversationId, {
    event: WEB_CONVERSATION_EVENT,
    data: { conversationId, messageId, role, content: '' },
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

export interface PostInput {
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
): Promise<NamedRefusal[] | { batchId: string; messageId: string }> {
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
    (await handleForProject(input.conversationId, input.projectId, tx as never)) ??
    input.actor.userId;
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
  await tx.insert(agentQuestions).values(
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
    await tx
      .update(agentQuestions)
      .set({
        status: 'void',
        voidReason: `carried into questionnaire ${batch.id}`,
        updatedAt: new Date(),
      })
      .where(
        and(
          inArray(
            agentQuestions.batchId,
            answeredBefore.map((b) => b.id),
          ),
          eq(agentQuestions.status, 'open'),
        ),
      );
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
  const open = await tx
    .update(questionnaireBatches)
    .set({ status: 'superseded', supersededAt: new Date(), supersededReason: reason })
    .where(
      and(
        eq(questionnaireBatches.onboardingId, onboardingId),
        inArray(questionnaireBatches.status, ['open', 'skipped']),
      ),
    )
    .returning({ id: questionnaireBatches.id });
  if (open.length === 0) return [];
  await tx
    .update(agentQuestions)
    .set({ status: 'void', voidReason: reason, updatedAt: new Date() })
    .where(
      and(
        inArray(
          agentQuestions.batchId,
          open.map((b) => b.id),
        ),
        eq(agentQuestions.status, 'open'),
      ),
    );
  return open.map((b) => b.id);
}

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

export interface SubmitInput {
  projectId: string;
  batchId: string;
  actor: QuestionnaireActor;
  answers: readonly QuestionnaireAnswer[];
  skip?: boolean | undefined;
  /** What the thread's owner writes in the same transaction: an onboarding goes back to the agent. */
  onSubmittedIn?: ((tx: TxOnly, batch: BatchRow, skipped: boolean) => Promise<void>) | undefined;
}

// cm:why one submit for the whole batch (BC-7): every answer, the user's answers message and the
// batch's state land in one write or none does, and an unanswered item stays open
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
    const byId = new Map(
      rows.map((r) => [
        (r.item as StoredItem).id,
        { item: r.item as StoredItem, open: r.status === 'open', row: r },
      ]),
    );
    const refusals = answerRefusals(byId, answers, skip);
    if (refusals.length) return refusals;
    const now = new Date();
    if (skip) {
      await tx
        .update(questionnaireBatches)
        .set({ status: 'skipped', skippedBy: input.actor.userId, skippedAt: now })
        .where(eq(questionnaireBatches.id, batch.id));
      await input.onSubmittedIn?.(tx, batch, true);
      return null;
    }
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
      await tx
        .update(agentQuestions)
        .set({
          status: 'answered',
          steps: [...steps.slice(0, -1), answeredStep(last, entry.item, a, input.actor.userId, at)],
          updatedAt: now,
        })
        .where(eq(agentQuestions.id, entry.row.id));
    }
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
    messageId = message?.id ?? null;
    // cm:why in a BA requirement room the answers are the person's turn: a window opens on them, so the
    // BA assistant answers as it would a typed message; an onboarding thread hands back through a job
    if (batch.requirementId && message) {
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
    await tx
      .update(questionnaireBatches)
      .set({
        status: 'submitted',
        submittedBy: input.actor.userId,
        submittedAt: now,
        answersMessageId: messageId,
      })
      .where(eq(questionnaireBatches.id, batch.id));
    await input.onSubmittedIn?.(tx, batch, false);
    return null;
  });
  if (refused) return { ok: false, refusals: refused };
  await announce(conversationId, messageId, 'user');
  return {
    ok: true,
    questionnaire: await batchView(db as Executor, input.projectId, input.batchId),
  };
}
