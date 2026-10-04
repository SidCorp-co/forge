// Notices: comments the system posts on an issue, once or every time, and the latest one carrying a marker.

import { type CommentIntent } from '@forge/contracts/record-events';
import { and, desc, eq, or, sql } from 'drizzle-orm';
import { db, type Tx } from '../db/client.js';
import { comments } from '../db/schema.js';
import { lockXact } from '../lib/advisory-lock.js';
import { type CommentThreadRow, insertComment, type NewComment } from './service.js';

/** A comment Forge itself posts on an issue: a note unless it says otherwise. */
type IssueNotice = {
  issueId: string;
  authorId: string;
  authorDeviceId?: string | null | undefined;
  body: string;
  intent?: CommentIntent | undefined;
  parentId?: string | null | undefined;
  announce?: NewComment['announce'];
};

/**
 * Post a notice through the one writer, so it is screened, mirrored and its mentions recorded the
 * way a comment through either door is.
 */
export async function postIssueNotice(notice: IssueNotice, tx: Tx = db): Promise<CommentThreadRow> {
  const { row } = await insertComment(
    {
      issueId: notice.issueId,
      authorId: notice.authorId,
      authorDeviceId: notice.authorDeviceId ?? null,
      body: notice.body,
      parentId: notice.parentId ?? null,
      intent: notice.intent ?? 'note',
      announce: notice.announce,
    },
    tx,
  );
  return row;
}

/**
 * Post a notice unless the issue's thread already carries `marker`, under a lock on the pair, so
 * any number of racing callers post it once. Null when it was already there.
 */
export async function postIssueNoticeOnce(
  notice: IssueNotice & { marker: string },
  tx: Tx = db,
): Promise<CommentThreadRow | null> {
  const { marker, ...rest } = notice;
  return tx.transaction(async (t) => {
    await lockXact(t, 'commentOnce', `${notice.issueId}:${marker}`);
    const [existing] = await t
      .select({ id: comments.id })
      .from(comments)
      .where(
        and(eq(comments.issueId, notice.issueId), sql`strpos(${comments.body}, ${marker}) > 0`),
      )
      .limit(1);
    if (existing) return null;
    return postIssueNotice(rest, t);
  });
}

/** The body of the latest comment on an issue carrying any of `markers`, or null. */
export async function latestIssueCommentWith(
  issueId: string,
  markers: readonly string[],
  tx: Tx = db,
): Promise<string | null> {
  if (markers.length === 0) return null;
  const [latest] = await tx
    .select({ body: comments.body })
    .from(comments)
    .where(
      and(
        eq(comments.issueId, issueId),
        or(...markers.map((m) => sql`strpos(${comments.body}, ${m}) > 0`)),
      ),
    )
    .orderBy(desc(comments.createdAt), desc(comments.id))
    .limit(1);
  return latest?.body ?? null;
}
