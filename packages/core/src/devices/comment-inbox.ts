/**
 * What a project's issue threads owe a person a reply to, read by its master's box every sweep: the
 * device room has no buffer, so this read, not the `comment` wake, is what makes it master work.
 */

import { sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { ISSUE_TERMINAL_STATUSES } from '../issues/status-sets.js';
import { formatIssueRef } from '../lib/issue-ref.js';

/** The most owed issues one read hands back; `count` still says how many there are. */
export const OWED_COMMENTS_LIMIT = 50;

export type OwedComment = {
  issueId: string;
  issueKey: string;
  status: string;
  commentId: string;
  authorId: string;
  createdAt: string;
};

/** A box wrote it or an agent account did: `comments/service.ts:writtenByAnAgent`'s rule. */
const BY_AN_AGENT = (alias: string) =>
  sql.raw(`(${alias}.author_device_id IS NOT NULL OR ${alias}_u.kind = 'agent')`);

// cm:guard owed = a PERSON's `question` comment (ISS-56: a note or a decision is not owed a reply)
// on a live issue (any status but closed/dropped, not archived) with no newer agent-authored
// comment on that issue; an agent's own comment is never owed, so a
// master's reply clears the thread and cannot owe itself. Terminal is out: a person's closing word
// is the commonest last comment there, and reopening the issue brings its thread back in.
export async function readOwedComments(
  projectId: string,
): Promise<{ items: OwedComment[]; count: number }> {
  const terminal = sql.join(
    ISSUE_TERMINAL_STATUSES.map((s) => sql`${s}`),
    sql`, `,
  );
  const rows = (await db.execute(sql`
    SELECT DISTINCT ON (i.id)
           i.id AS issue_id, i.iss_seq, p.issue_prefix, i.status,
           c.id AS comment_id, c.author_id, c.created_at
    FROM issues i
    JOIN projects p ON p.id = i.project_id
    JOIN comments c ON c.issue_id = i.id
    JOIN users c_u ON c_u.id = c.author_id
    WHERE i.project_id = ${projectId}
      AND i.archived_at IS NULL
      AND i.status NOT IN (${terminal})
      AND NOT ${BY_AN_AGENT('c')}
      AND c.intent = 'question'
      AND NOT EXISTS (
        SELECT 1 FROM comments a
        JOIN users a_u ON a_u.id = a.author_id
        WHERE a.issue_id = c.issue_id
          AND ${BY_AN_AGENT('a')}
          AND a.created_at > c.created_at
      )
    ORDER BY i.id, c.created_at DESC, c.id DESC
  `)) as unknown as Array<Record<string, unknown>>;

  const owed = rows
    .map(
      (r): OwedComment => ({
        issueId: String(r.issue_id),
        issueKey: formatIssueRef(r.issue_prefix as string | null, Number(r.iss_seq)),
        status: String(r.status),
        commentId: String(r.comment_id),
        authorId: String(r.author_id),
        createdAt: new Date(r.created_at as string | Date).toISOString(),
      }),
    )
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  return { items: owed.slice(0, OWED_COMMENTS_LIMIT), count: owed.length };
}
