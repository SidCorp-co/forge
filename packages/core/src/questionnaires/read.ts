/**
 * The reads of a questionnaire: a batch with its items (agent_questions rows carrying batch_id) as
 * every surface sees it, and the per-thread facts a new batch is checked against.
 */

import type { SensitiveDataLevel } from '@forge/contracts/data-policy';
import {
  QUESTIONNAIRE_MAX_ROUNDS,
  type QuestionnaireAnswer,
  type QuestionnaireItem,
  type QuestionnaireItemState,
  type QuestionnaireItemView,
  type QuestionnaireView,
} from '@forge/contracts/onboarding';
import { and, asc, eq, gte, inArray } from 'drizzle-orm';
import { HTTPException } from 'hono/http-exception';
import { db, type Tx } from '../db/client.js';
import { questionnaireBatches } from '../db/schema-onboarding.js';
import { agentQuestions, type QuestionStep } from '../db/schema-questions.js';
import {
  dataPolicyOf,
  type EgressDeep,
  type EgressReader,
  type EgressSurface,
  egressAt,
  isProviderBound,
} from '../lib/data-egress.js';
import { questionnaireSurface } from '../questions/index.js';

export { questionnaireSurface };

export type Executor = typeof db | Tx;
export type BatchRow = typeof questionnaireBatches.$inferSelect;
export type ItemRow = typeof agentQuestions.$inferSelect;

/** The item as stored on its row: the posted item and where it sat in the batch. */
export type StoredItem = QuestionnaireItem & { position: number };

export const notFound = (message: string) =>
  new HTTPException(404, { message, cause: { code: 'NOT_FOUND' } });

export function answerOf(item: QuestionnaireItem, step: QuestionStep | undefined) {
  if (!step?.answeredAt) return null;
  const s = step as QuestionStep & {
    chosenOptionId?: string;
    chosenOptionIds?: string[];
    answerText?: string;
  };
  const answer: Omit<QuestionnaireAnswer, 'itemId'> =
    item.control === 'text'
      ? { text: s.answerText ?? '' }
      : item.control === 'multi'
        ? { choices: s.chosenOptionIds ?? [] }
        : item.control === 'accept_reject'
          ? { decision: s.chosenOptionId === 'accept' ? 'accept' : 'reject' }
          : { choice: s.chosenOptionId ?? '' };
  return { answer, answeredBy: step.answeredBy ?? null, answeredAt: step.answeredAt };
}

export function itemState(row: Pick<ItemRow, 'status'>): QuestionnaireItemState {
  return row.status === 'open' ? 'open' : row.status === 'answered' ? 'answered' : 'void';
}

export function itemViewOf(row: ItemRow): QuestionnaireItemView {
  const { position: _position, ...item } = row.item as StoredItem;
  const got = answerOf(item, row.steps.at(-1));
  return {
    ...item,
    questionId: row.id,
    state: itemState(row),
    answer: got?.answer ?? null,
    answeredBy: got?.answeredBy ?? null,
    answeredAt: got?.answeredAt ?? null,
  };
}

export function batchViewOf(
  batch: BatchRow,
  rows: readonly ItemRow[],
  sensitiveData: SensitiveDataLevel,
): QuestionnaireView {
  const items = [...rows]
    .sort((a, b) => (a.item as StoredItem).position - (b.item as StoredItem).position)
    .map(itemViewOf);
  return {
    id: batch.id,
    conversationId: batch.conversationId,
    onboardingId: batch.onboardingId,
    requirementId: batch.requirementId,
    title: batch.title,
    intro: batch.intro,
    round: batch.round,
    maxRounds: QUESTIONNAIRE_MAX_ROUNDS,
    status: batch.status,
    items,
    answered: items.filter((i) => i.state === 'answered').length,
    open: items.filter((i) => i.state === 'open').length,
    postedBy: batch.postedBy,
    postedAt: batch.createdAt.toISOString(),
    submittedBy: batch.submittedBy,
    submittedAt: batch.submittedAt?.toISOString() ?? null,
    skippedAt: batch.skippedAt?.toISOString() ?? null,
    supersededAt: batch.supersededAt?.toISOString() ?? null,
    supersededBy: batch.supersededBy,
    messageId: batch.messageId,
    answersMessageId: batch.answersMessageId,
    sensitiveData,
  };
}

/** A batch of `projectId`, locked for update when asked; 404 naming it otherwise. */
export async function batchIn(
  tx: Executor,
  projectId: string,
  id: string,
  lock = false,
): Promise<BatchRow> {
  const query = tx
    .select()
    .from(questionnaireBatches)
    .where(and(eq(questionnaireBatches.id, id), eq(questionnaireBatches.projectId, projectId)));
  const [row] = lock ? await query.for('update') : await query;
  if (!row) throw notFound(`project ${projectId} holds no questionnaire ${id}`);
  return row;
}

export async function itemsOf(tx: Executor, batchIds: readonly string[]): Promise<ItemRow[]> {
  if (batchIds.length === 0) return [];
  return tx
    .select()
    .from(agentQuestions)
    .where(inArray(agentQuestions.batchId, [...batchIds]));
}

export async function batchView(tx: Executor, projectId: string, id: string) {
  const batch = await batchIn(tx, projectId, id);
  return batchViewOf(batch, await itemsOf(tx, [batch.id]), await dataPolicyOf(projectId));
}

/** Every batch posted in a conversation, oldest first, as the thread renders them. */
export async function batchesOfConversation(
  conversationId: string,
  tx: Executor = db,
): Promise<QuestionnaireView[]> {
  const batches = await tx
    .select()
    .from(questionnaireBatches)
    .where(eq(questionnaireBatches.conversationId, conversationId))
    .orderBy(asc(questionnaireBatches.createdAt));
  const rows = await itemsOf(
    tx,
    batches.map((b) => b.id),
  );
  const projects = [...new Set(batches.map((b) => b.projectId))];
  const levels = new Map(
    await Promise.all(projects.map(async (p) => [p, await dataPolicyOf(p)] as const)),
  );
  return batches.map((b) =>
    batchViewOf(
      b,
      rows.filter((r) => r.batchId === b.id),
      levels.get(b.projectId) ?? 'off',
    ),
  );
}

export async function questionnairesAs(
  reader: EgressReader,
  projectId: string,
  views: QuestionnaireView[],
): Promise<EgressDeep<QuestionnaireView[]>> {
  if (!isProviderBound(reader)) return { ok: true, value: views };
  const level = await dataPolicyOf(projectId);
  const out: QuestionnaireView[] = [];
  for (const v of views) {
    const one = egressAt(level, questionnaireSurface(v), v, `questionnaire ${v.id}`);
    if (!one.ok) return one;
    out.push(one.value);
  }
  return { ok: true, value: out };
}

export async function openBatchOf(tx: Executor, conversationId: string) {
  const [row] = await tx
    .select()
    .from(questionnaireBatches)
    .where(
      and(
        eq(questionnaireBatches.conversationId, conversationId),
        inArray(questionnaireBatches.status, ['open', 'skipped']),
      ),
    )
    .limit(1);
  return row ?? null;
}

/**
 * What a new batch in this thread is checked against: item ids answered since `since` (the
 * series), and recommendations rejected at any time.
 */
export async function priorAnswers(
  tx: Executor,
  conversationId: string,
  since: Date,
): Promise<{ answered: Set<string>; rejected: Set<string> }> {
  const rows = await tx
    .select({
      item: agentQuestions.item,
      status: agentQuestions.status,
      steps: agentQuestions.steps,
      createdAt: questionnaireBatches.createdAt,
    })
    .from(agentQuestions)
    .innerJoin(questionnaireBatches, eq(questionnaireBatches.id, agentQuestions.batchId))
    .where(
      and(
        eq(questionnaireBatches.conversationId, conversationId),
        eq(agentQuestions.status, 'answered'),
      ),
    );
  const answered = new Set<string>();
  const rejected = new Set<string>();
  for (const r of rows) {
    const item = r.item as StoredItem;
    const got = answerOf(item, r.steps.at(-1));
    if (item.control === 'accept_reject' && got?.answer.decision === 'reject')
      rejected.add(item.id);
    if (r.createdAt >= since) answered.add(item.id);
  }
  return { answered, rejected };
}

/** How many batches a requirement room sent: its rounds have no re-analysis to reset them. */
export async function roundsInConversation(tx: Executor, conversationId: string, since?: Date) {
  const rows = await tx
    .select({ id: questionnaireBatches.id, status: questionnaireBatches.status })
    .from(questionnaireBatches)
    .where(
      and(
        eq(questionnaireBatches.conversationId, conversationId),
        since ? gte(questionnaireBatches.createdAt, since) : undefined,
      ),
    );
  return rows.filter((r) => r.status !== 'superseded').length;
}
