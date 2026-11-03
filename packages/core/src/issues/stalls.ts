// Delivery stalls (REQ-67 BC-6): the one writer of `stalls`. A stall starts in the transaction of
// the act that starts it and ends in the act that clears it:
//   unclear_item       a question about a requirement or feedback item, or a reporter's
//                      clarification (`questions/write.ts:insertQuestion`) → its answer or void
//   defect             a failed verdict's reopen (`fail-reopen.ts`) → the next merge mark or a drop
//   waiting_on_person  a `needs_info` park on a person (`apply-transition.ts`) → leaving the park
// Kernel input: a stall the caller cannot place is refused by name, never guessed or skipped.

import {
  STALL_CAUSES,
  STALL_REFUSAL_CODES,
  type StallCause,
  type StallEnding,
  type StallRefusalCode,
} from '@forge/contracts/stalls';
import { and, eq, inArray, isNull, type SQL } from 'drizzle-orm';
import type { Tx } from '../db/client.js';
import { stalls } from '../db/schema.js';
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

/** What a clearing act ends: the open stalls of one cause on an issue, or the one a question raised. */
export type StallScope =
  | { cause: StallCause; issueId: string }
  | { questionIds: readonly string[] };

/** Ends every open stall in scope with the act that cleared it; returns how many it ended. */
export async function endStalls(tx: Tx, scope: StallScope, by: StallEnding): Promise<number> {
  let where: SQL | undefined;
  if ('questionIds' in scope) {
    if (scope.questionIds.length === 0) return 0;
    where = inArray(stalls.questionId, [...scope.questionIds]);
  } else {
    where = and(eq(stalls.cause, scope.cause), eq(stalls.issueId, scope.issueId));
  }
  const ended = await tx
    .update(stalls)
    .set({ endedAt: new Date(), endedBy: by })
    .where(and(where, isNull(stalls.endedAt)))
    .returning({ id: stalls.id });
  return ended.length;
}
