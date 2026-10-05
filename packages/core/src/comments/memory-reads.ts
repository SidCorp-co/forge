// What memory reads of comments, handed to it through `memory/ports.ts` at boot.
import { and, desc, eq, gte, isNull } from 'drizzle-orm';
import { db } from '../db/client.js';
import { comments, issues } from '../db/schema.js';

/** The newest `limit` comment bodies on the issue, newest first. */
export async function recentCommentBodies(issueId: string, limit: number): Promise<string[]> {
  const rows = await db
    .select({ body: comments.body })
    .from(comments)
    .where(eq(comments.issueId, issueId))
    .orderBy(desc(comments.createdAt))
    .limit(limit);
  return rows.map((r) => r.body);
}

/** The project's comments on unarchived issues since `since`, newest first. */
export function commentsSince(projectId: string, since: Date, limit: number) {
  return db
    .select({ body: comments.body, issueTitle: issues.title })
    .from(comments)
    .innerJoin(issues, and(eq(comments.issueId, issues.id), isNull(issues.archivedAt)))
    .where(and(eq(issues.projectId, projectId), gte(comments.createdAt, since)))
    .orderBy(desc(comments.createdAt))
    .limit(limit);
}
