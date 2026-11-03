// Delivery stalls (REQ-67 BC-6): the one writer of `stalls`. A stall starts in the transaction of
// the act that starts it and ends in the act that clears it:
//   unclear_item       a question about a requirement or feedback item, or a reporter's
//                      clarification (`questions/stall-start.ts`) → its answer, void or delete
//                      (`stalls_question_end_trg`, migration 0589)
//   defect             a failed verdict's reopen (`fail-reopen.ts`) → the next merge mark or a drop
//   waiting_on_person  a `needs_info` park on a person (`apply-transition.ts`) → leaving the park
// Kernel input: a stall the caller cannot place is refused by name, never guessed or skipped.

import type { QuestionAboutRequest } from '@forge/contracts/questions';
import {
  STALL_CAUSES,
  STALL_REFUSAL_CODES,
  type StallCause,
  type StallEnding,
  type StallRefusalCode,
} from '@forge/contracts/stalls';
import { and, eq, isNull } from 'drizzle-orm';
import type { Tx } from '../db/client.js';
import { type IssueStatus, stalls } from '../db/schema.js';
import { refuser } from '../lib/refusal.js';

const refuseStall = refuser<StallRefusalCode>(STALL_REFUSAL_CODES[0]);

export interface StallStart {
  projectId: string;
  cause: StallCause;
  requirementId?: string | null | undefined;
  feedbackId?: string | null | undefined;
  issueId?: string | null | undefined;
  question?: { id: string; text: string } | null | undefined;
}

/** The row a start writes, or the refusal naming what it could not place. Pure: the unit test's subject. */
export function placeStall(input: StallStart): typeof stalls.$inferInsert {
  if (!(STALL_CAUSES as readonly string[]).includes(input.cause)) {
    throw refuseStall(
      'STALL_CAUSE_UNKNOWN',
      `"${input.cause}" is not a stall cause: it is one of ${STALL_CAUSES.join(', ')}`,
      '/cause',
    );
  }
  if (input.cause === 'unclear_item' && !input.requirementId && !input.feedbackId) {
    throw refuseStall(
      'STALL_ITEM_MISSING',
      'an unclear-item stall names the requirement or feedback item that was unclear, and this one names neither',
      '/requirementId',
    );
  }
  if (input.cause !== 'unclear_item' && !input.issueId) {
    throw refuseStall(
      'STALL_ISSUE_MISSING',
      `a ${input.cause} stall names the issue it stalled, and this one names none`,
      '/issueId',
    );
  }
  return {
    projectId: input.projectId,
    cause: input.cause,
    requirementId: input.requirementId ?? null,
    feedbackId: input.feedbackId ?? null,
    issueId: input.issueId ?? null,
    questionId: input.question?.id ?? null,
    question: input.question?.text ?? null,
  };
}

/** Records a stall in the caller's transaction. */
export async function startStall(tx: Tx, input: StallStart): Promise<void> {
  await tx.insert(stalls).values(placeStall(input));
}

/**
 * Ends the open stalls of one cause on an issue with the act that cleared it. A question's stall is
 * ended by the question's own end, in its statement (`stalls_question_end_trg`, migration 0589).
 */
export async function endStalls(
  tx: Tx,
  scope: { cause: StallCause; issueId: string },
  by: StallEnding,
): Promise<number> {
  const ended = await tx
    .update(stalls)
    .set({ endedAt: new Date(), endedBy: by })
    .where(
      and(eq(stalls.cause, scope.cause), eq(stalls.issueId, scope.issueId), isNull(stalls.endedAt)),
    )
    .returning({ id: stalls.id });
  return ended.length;
}

/** What an issue's move tells the stalls it starts or clears. */
export interface StallMove {
  issue: { id: string; projectId: string };
  fromStatus: IssueStatus;
  toStatus: IssueStatus;
  /** The park's own question, where the move minted one. */
  parkQuestion: { id: string; text: string } | null;
  /** The park waits on another issue's merge mark: ordering, not a person. */
  awaitsMerge: boolean;
  /** The park's question names a product item: that is an unclear-item stall, started with it. */
  aboutItem: boolean;
}

/**
 * The stalls one issue move starts and ends, in its transaction: a `needs_info` park on a person
 * starts a wait, and leaving the park ends it; a move to `awaiting_release` or `closed` stands on a
 * merge mark and ends a defect; a drop ends every stall the issue still holds.
 */
export async function stallsOfMove(tx: Tx, move: StallMove): Promise<void> {
  const { issue, fromStatus, toStatus } = move;
  if (toStatus === 'dropped') {
    await endStalls(tx, { cause: 'defect', issueId: issue.id }, 'dropped');
    await endStalls(tx, { cause: 'waiting_on_person', issueId: issue.id }, 'dropped');
    return;
  }
  if (fromStatus === 'needs_info') {
    await endStalls(tx, { cause: 'waiting_on_person', issueId: issue.id }, 'resumed');
  }
  if (toStatus === 'awaiting_release' || toStatus === 'closed') {
    await endStalls(tx, { cause: 'defect', issueId: issue.id }, 'merged');
  }
  if (toStatus === 'needs_info' && !move.awaitsMerge && !move.aboutItem) {
    await startStall(tx, {
      projectId: issue.projectId,
      cause: 'waiting_on_person',
      issueId: issue.id,
      question: move.parkQuestion,
    });
  }
}

/** Whether a park's `about` names a product item, whose question starts the stall instead. */
export function aboutsItem(about: QuestionAboutRequest | undefined): boolean {
  return about !== undefined && ('requirement' in about || 'feedback' in about);
}
