// A steward decision asks what to do with an item as it stood. Once the item moves, the answer has
// nothing left to act on, so the decision is void (REQ-68 BC-7, REQ-41 BC-26).
//
// Three paths enforce this:
// - An issue move or a requirement move voids the decision inside its own transaction.
// - Every other move (a feedback item's, or one made before this existed) is caught at read time,
//   so the decision leaves Needs you at once.
// - The upkeep sweep then voids those rows, so an open row never claims an answer is still owed.

import { ISSUE_STATUS_LABELS } from '@forge/contracts/issue-vocabulary';
import { QUESTION_MACHINE } from '@forge/contracts/question-machine';
import { isStewardDecisionQuestion } from '@forge/contracts/steward';
import { and, eq, inArray, type SQL, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import type { IssueStatus } from '../db/schema.js';
import { agentQuestions, isChoiceStep, type QuestionStep } from '../db/schema-questions.js';
import type { IssueDependencyExecutor } from '../issues/index.js';
import { type KernelActor, transition } from '../lifecycle/index.js';

type Executor = IssueDependencyExecutor;
type ItemKind = 'issue' | 'requirement' | 'feedback';

const QUESTION_ITEM_MOVED = 'item_moved';

/** The feedback item a question is on: its own column, else the item a steward decision is about. */
const feedbackOf = sql`coalesce(${agentQuestions.feedbackId},
  case when ${agentQuestions.about} ->> 'kind' = 'feedback'
    then (${agentQuestions.about} ->> 'feedbackId')::uuid end)`;

/** The rows that name this item, whichever column holds it. */
function namesItem(item: { kind: ItemKind; id: string }): SQL {
  if (item.kind === 'issue') return eq(agentQuestions.issueId, item.id);
  if (item.kind === 'requirement') return eq(agentQuestions.requirementId, item.id);
  return sql`${feedbackOf} = ${item.id}::uuid`;
}

/** When the item a question stands on or names last changed status; null if it never has. */
export const itemLastMovedAt = sql<string | null>`greatest(
  (select max(kt.created_at) from kernel_transitions kt
    where kt.entity = 'issue' and kt.entity_id = ${agentQuestions.issueId}),
  (select max(kt.created_at) from kernel_transitions kt
    where kt.entity = 'requirement' and kt.entity_id = ${agentQuestions.requirementId}),
  (select max(kt.created_at) from kernel_transitions kt
    where kt.entity = 'feedback' and kt.entity_id = ${feedbackOf}))`;

/** Whether a round offers the steward's fixed decisions. A person's or a run's question does not. */
export const isStewardDecisionRound = (round: QuestionStep | null | undefined): boolean =>
  round != null && isChoiceStep(round) && isStewardDecisionQuestion(round.options);

/**
 * Whether a steward decision's item moved after its current round was asked. `at` is when the round
 * was asked, and `movedAt` is `itemLastMovedAt`.
 */
export function movedSinceAsked(row: {
  current: QuestionStep | null;
  at: string;
  movedAt: string | Date | null;
}): boolean {
  if (!row.movedAt || !isStewardDecisionRound(row.current)) return false;
  return new Date(row.movedAt).getTime() > new Date(row.at).getTime();
}

/** How a status reads in the sentence a void records: an issue's by its label, anything else as stored. */
const statusWords = (kind: ItemKind, status: string) =>
  kind === 'issue'
    ? (ISSUE_STATUS_LABELS[status as IssueStatus] ?? status)
    : status.replace(/_/g, ' ');

interface Move {
  item: { kind: ItemKind; id: string };
  /** The status it moved from, where the mover read it; null where it did not. */
  fromStatus: string | null;
  toStatus: string;
  /** The move's own reason, in the mover's words; null when the move gave none. */
  reason: string | null;
  by: string;
  actor: KernelActor;
  source: string;
}

async function voidAsMoved(tx: Executor, ids: string[], move: Move): Promise<string[]> {
  if (ids.length === 0) return [];
  const why = move.reason?.trim();
  const kind = move.item.kind;
  const from = move.fromStatus ? ` from ${statusWords(kind, move.fromStatus)}` : '';
  const sentence = `the ${kind === 'feedback' ? 'feedback item' : kind} moved${from} to ${statusWords(kind, move.toStatus)} without this being answered, so ${move.fromStatus === 'draft' ? 'the draft' : 'what'} it asked about is gone and no answer to it can act${why ? `: ${why}` : ''}`;
  const voided = await transition(tx, QUESTION_MACHINE, {
    to: 'void',
    from: 'open',
    set: {
      voidReason: sentence,
      endedBy: move.by,
      endedReason: QUESTION_ITEM_MOVED,
      updatedAt: new Date(),
    },
    where: inArray(agentQuestions.id, ids),
    reason: sentence,
    actor: move.actor,
    source: move.source,
    returning: ['id'],
  });
  return voided.rows.map((r) => r.id);
}

/**
 * Void the steward's open decisions on an item, inside the transaction that moves it. A person's or
 * a run's question on the item stays open. A move made by answering a decision answers it first, in
 * the same transaction, so nothing is left here to void.
 */
export async function voidStewardDecisionsOnMove(tx: Executor, move: Move): Promise<string[]> {
  const open = await tx
    .select({ id: agentQuestions.id, steps: agentQuestions.steps })
    .from(agentQuestions)
    .where(and(namesItem(move.item), eq(agentQuestions.status, 'open')));
  const ids = open.filter((q) => isStewardDecisionRound(q.steps.at(-1))).map((q) => q.id);
  return voidAsMoved(tx, ids, move);
}

/** The newest status change of an item: what the void sentence names. */
async function lastMoveOf(kind: ItemKind, id: string) {
  const rows = await db.execute<{
    from_status: string | null;
    to_status: string;
    reason: string | null;
  }>(
    sql`select from_status, to_status, reason from kernel_transitions
      where entity = ${kind} and entity_id = ${id}::uuid
      order by created_at desc limit 1`,
  );
  return rows[0] ?? null;
}

/**
 * Void every open steward decision whose item moved after its round was asked: the moves no door
 * here voids at the time (a feedback item's, or one made before this existed). Returns the ids
 * voided.
 */
export async function sweepMovedDecisions(): Promise<string[]> {
  const rows = await db
    .select({
      id: agentQuestions.id,
      issueId: agentQuestions.issueId,
      requirementId: agentQuestions.requirementId,
      feedbackId: sql<string | null>`${feedbackOf}`,
      createdAt: agentQuestions.createdAt,
      current: sql<QuestionStep | null>`${agentQuestions.steps} -> -1`,
      movedAt: itemLastMovedAt,
    })
    .from(agentQuestions)
    .where(
      and(
        eq(agentQuestions.status, 'open'),
        eq(agentQuestions.blockerKind, 'human'),
        sql`${itemLastMovedAt} is not null`,
      ),
    );
  const voided: string[] = [];
  for (const r of rows) {
    const at = r.current?.askedAt ?? r.createdAt.toISOString();
    if (!movedSinceAsked({ current: r.current, at, movedAt: r.movedAt })) continue;
    const item: Move['item'] = r.issueId
      ? { kind: 'issue', id: r.issueId }
      : r.requirementId
        ? { kind: 'requirement', id: r.requirementId }
        : { kind: 'feedback', id: r.feedbackId as string };
    const move = await lastMoveOf(item.kind, item.id);
    if (!move) continue;
    const ids = await db.transaction((tx) =>
      voidAsMoved(tx, [r.id], {
        item,
        fromStatus: move.from_status,
        toStatus: move.to_status,
        reason: move.reason,
        by: 'sweeper',
        actor: { type: 'system' },
        source: 'questions',
      }),
    );
    voided.push(...ids);
  }
  return voided;
}
