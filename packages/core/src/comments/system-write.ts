import { and, eq, sql } from 'drizzle-orm';
import { db, type Tx } from '../db/client.js';
import { comments } from '../db/schema.js';
import { loadCredentialsByIssue, reportWithheld, withholdCredentials } from './credential-guard.js';

/**
 * The door core's own writers post a comment through.
 *
 * A system writer has no person to refuse to, so a stored test credential in its text is replaced
 * in place by a marker naming it, the rest of the text is kept, and the withhold is logged. A
 * caller's write goes through `insertComment` instead, which refuses by name. Nothing else writes
 * the `comments` table: `single-door.test.ts` fails naming the file and line of any other writer.
 */
export interface SystemComment {
  issueId: string;
  authorId: string;
  body: string;
  authorDeviceId?: string | null | undefined;
  parentId?: string | null | undefined;
}

/** `items`' bodies as they should be stored: each with its stored credentials replaced in place. */
async function withheldBodies(
  items: ReadonlyArray<{ issueId: string; body: string }>,
  executor: Tx,
): Promise<string[]> {
  const byIssue = await loadCredentialsByIssue([...new Set(items.map((i) => i.issueId))], executor);
  return items.map((item) => {
    const credentials = byIssue.get(item.issueId) ?? [];
    if (credentials.length === 0) return item.body;
    const { text, ids } = withholdCredentials(item.body, credentials);
    reportWithheld(item.issueId, ids);
    return text;
  });
}

/** One system-authored body, withheld; for the writer that compares a body before it posts it. */
export async function withholdForIssue(
  issueId: string,
  body: string,
  executor: Tx = db,
): Promise<string> {
  const [safe] = await withheldBodies([{ issueId, body }], executor);
  return safe as string;
}

/** Post one system-authored comment, withholding any stored credential from its body. */
export async function postSystemComment(row: SystemComment, executor: Tx = db): Promise<void> {
  const [body] = await withheldBodies([row], executor);
  await executor.insert(comments).values({ ...row, body: body as string });
}

/** Post several system-authored comments in one write, each withheld on its own issue. */
export async function postSystemComments(
  rows: readonly SystemComment[],
  executor: Tx = db,
): Promise<void> {
  if (rows.length === 0) return;
  const bodies = await withheldBodies(rows, executor);
  await executor
    .insert(comments)
    .values(rows.map((row, at) => ({ ...row, body: bodies[at] as string })));
}

export interface SystemCommentRow {
  id: string;
  issueId: string;
  body: string;
  parentId: string | null;
}

/** The same write, reading the row back for a writer that needs its id. */
export async function insertSystemComment(
  row: SystemComment,
  executor: Tx = db,
): Promise<SystemCommentRow | undefined> {
  const [body] = await withheldBodies([row], executor);
  const [written] = await executor
    .insert(comments)
    .values({ ...row, body: body as string })
    .returning({
      id: comments.id,
      issueId: comments.issueId,
      body: comments.body,
      parentId: comments.parentId,
    });
  return written;
}

/** Replace the body of a comment core posted earlier; its id, or `null` when it is gone or on another issue. */
export async function rewriteSystemComment(
  args: { commentId: string; issueId: string; body: string },
  executor: Tx = db,
): Promise<string | null> {
  const body = await withholdForIssue(args.issueId, args.body, executor);
  const [row] = await executor
    .update(comments)
    .set({ body, updatedAt: sql`now()` })
    .where(and(eq(comments.id, args.commentId), eq(comments.issueId, args.issueId)))
    .returning({ id: comments.id });
  return row?.id ?? null;
}
