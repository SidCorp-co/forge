// The reasoned decisions written on feedback items and requirements (ISS-654, REQ-48 BC-5): a
// decision comment (`intent: decision`) posted at `projects/:id/feedback/:fb/comments` or
// `projects/:id/requirements/:req/comments`, read in the shape an issue's `decision` record is read
// (`issues/record-events/decision-read.ts`): `reason` is its why, and `reversedWhen` its until, which
// ends it only on a date it names (`issues/record-events/decision-until.ts`). The steward reads one
// written after its ask about the item as that ask's answer.

import type { EntityCommentView } from '@forge/contracts/comments';
import { and, desc, eq, inArray } from 'drizzle-orm';
import { db } from '../db/client.js';
import { comments } from '../db/schema-comments.js';
import { readDecisionUntil, untilReadingWarnings } from '../issues/index.js';

/** The kinds of item, besides an issue, a steward ask is about and a decision comment sits on. */
export type DecidedItemKind = 'feedback' | 'requirement';

export interface ItemDecision {
  subjectId: string;
  at: Date;
  decision: string | null;
  why: string;
  /** The date `reversedWhen` names, after which it stops holding; null for none or a condition, which holds. */
  until: Date | null;
}

const COLUMN = { feedback: comments.feedbackId, requirement: comments.requirementId } as const;

const trimmed = (text: string | undefined): string | null => {
  const value = text?.trim() ?? '';
  return value.length > 0 ? value : null;
};

/**
 * Every reasoned decision on these feedback items or requirements, newest first, but those whose
 * author is one of `exceptUserIds` (the steward's own account): the steward never reads its own
 * decision as an answer. One a person took back (deleted) is gone, so it answers nothing.
 */
export async function reasonedDecisionsOnItems(
  kind: DecidedItemKind,
  ids: readonly string[],
  exceptUserIds: readonly string[] = [],
): Promise<ItemDecision[]> {
  if (ids.length === 0) return [];
  const column = COLUMN[kind];
  const rows = await db
    .select({
      subjectId: column,
      at: comments.createdAt,
      authorId: comments.authorId,
      decision: comments.decision,
    })
    .from(comments)
    .where(and(inArray(column, [...ids]), eq(comments.intent, 'decision')))
    .orderBy(desc(comments.createdAt), desc(comments.id));
  const except = new Set(exceptUserIds);
  return rows.flatMap((row) => {
    if (except.has(row.authorId) || !row.subjectId) return [];
    const why = trimmed(row.decision?.reason);
    if (!why) return [];
    const until = trimmed(row.decision?.reversedWhen);
    const read = until ? readDecisionUntil(until) : null;
    return [
      {
        subjectId: row.subjectId,
        at: row.at,
        decision: trimmed(row.decision?.decision),
        why,
        until: read?.kind === 'date' ? read.at : null,
      },
    ];
  });
}

/**
 * What the writer of a decision on a feedback item or a requirement is told about its `reversedWhen`:
 * read as a condition, or a date already passed, as an issue's `until` is (ISS-607). A decision
 * elsewhere, or one with no `reversedWhen`, is told nothing.
 */
export function decisionCommentWarnings(comment: EntityCommentView): string[] {
  const scope = comment.target.scope;
  if (comment.intent !== 'decision' || (scope !== 'feedback' && scope !== 'requirement')) return [];
  const until = trimmed(comment.decision?.reversedWhen);
  if (!until) return [];
  return untilReadingWarnings('reversedWhen', until, new Date(comment.updatedAt));
}
