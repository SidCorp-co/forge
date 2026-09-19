import { and, desc, eq, like } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { commentAttachments, comments } from '../../db/schema.js';
import { getStorage } from '../../storage/index.js';
import { reportHead } from '../bench/history/report.js';
import { type HistoryResult, readHistoryResult } from '../bench/history/result.js';

type Executor = Pick<typeof db, 'select'>;

/** The history file of the newest weekly attachment on the issue; null where there is none. */
export async function readPreviousHistory(
  issueId: string,
  dbi: Executor = db,
  storage = getStorage,
): Promise<HistoryResult | null> {
  const [row] = await dbi
    .select({ name: commentAttachments.name, path: commentAttachments.path })
    .from(commentAttachments)
    .innerJoin(comments, eq(comments.id, commentAttachments.commentId))
    .where(
      and(eq(comments.issueId, issueId), like(commentAttachments.name, 'assistant-history-%.json')),
    )
    .orderBy(desc(commentAttachments.createdAt))
    .limit(1);
  if (!row) return null;
  const bytes = await storage().get(row.path);
  return readHistoryResult(bytes.toString('utf8'), row.name);
}

/** Whether a REPORT for the window is already on the issue; a failure comment does not count. */
export async function hasPublishedReport(
  issueId: string,
  windowId: string,
  dbi: Executor = db,
): Promise<boolean> {
  const rows = await dbi
    .select({ body: comments.body })
    .from(comments)
    .where(and(eq(comments.issueId, issueId), like(comments.body, `${reportHead(windowId)}%`)));
  return rows.length > 0;
}
