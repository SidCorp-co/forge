// Correcting what a comment is for (ISS-585, REQ-33 BC-2): a question that was a note, a note that
// was a decision. The same comment takes the new intent, so its id, body and replies stay where
// they are and no second comment repeats it. A decision's fields belong to intent decision alone, so
// a comment moved off decision drops them; its body, which wrote them out, stays readable.

import type { CommentRefusal } from '@forge/contracts/comments';
import { type CommentIntent, isCommentIntent } from '@forge/contracts/record-events';
import { eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { comments } from '../db/schema.js';
import type { Actor } from '../issues/index.js';
import { emitEvent } from '../outbox/index.js';
import { type CommentThreadRow, commentThreadColumns, intentRefusal } from './service.js';
import { onIssue } from './thread-read.js';

/** The refusal of a correction to the intent the comment already has, or null. */
export function unchangedIntentRefusal(
  current: CommentIntent,
  next: CommentIntent,
): CommentRefusal | null {
  if (current !== next) return null;
  return {
    code: 'COMMENT_INTENT_UNCHANGED',
    path: '/intent',
    detail: `this comment is already a ${current}; send intent only to change it, to one of the other two`,
  };
}

/** The intent sent, checked against the closed set (`COMMENT_INTENT_UNKNOWN` naming it otherwise). */
export function checkedIntent(sent: string): CommentIntent {
  if (!isCommentIntent(sent)) throw intentRefusal(sent);
  return sent;
}

/**
 * Give one issue comment a new intent, in place. The caller has checked who may; this refuses the
 * intent it already has, and logs the correction as an edit (`comment.updated` with `intent`).
 */
export async function correctCommentIntent(
  commentId: string,
  intent: CommentIntent,
  announce: { actor: Actor; projectId: string },
): Promise<CommentThreadRow | CommentRefusal | null> {
  return db.transaction(async (t) => {
    const [existing] = await t
      .select({ intent: comments.intent, body: comments.body })
      .from(comments)
      .where(eq(comments.id, commentId))
      .for('update');
    if (!existing) return null;
    const unchanged = unchangedIntentRefusal(existing.intent, intent);
    if (unchanged) return unchanged;
    const [row] = await t
      .update(comments)
      .set({
        intent,
        ...(intent === 'decision' ? {} : { decision: null }),
        updatedAt: new Date(),
      })
      .where(eq(comments.id, commentId))
      .returning(commentThreadColumns);
    if (!row) return null;
    const edited = onIssue(row);
    await emitEvent(t, 'comment.updated', {
      issueId: edited.issueId,
      projectId: announce.projectId,
      actor: announce.actor,
      commentId: edited.id,
      before: existing.body,
      after: edited.body,
      intent: { before: existing.intent, after: edited.intent },
    });
    return edited;
  });
}
