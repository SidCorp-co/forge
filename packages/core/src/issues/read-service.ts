import { and, eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { issues, projects } from '../db/schema.js';

export type IssueRow = typeof issues.$inferSelect;

/** Returns null rather than throwing: the error vocabulary belongs to the transport. */
export async function findIssueById(issueId: string): Promise<IssueRow | null> {
  const [row] = await db.select().from(issues).where(eq(issues.id, issueId)).limit(1);
  return row ?? null;
}

export async function findIssueByDisplaySeq(
  projectId: string,
  issSeq: number,
): Promise<IssueRow | null> {
  const [row] = await db
    .select()
    .from(issues)
    .where(and(eq(issues.projectId, projectId), eq(issues.issSeq, issSeq)))
    .limit(1);
  return row ?? null;
}

/** A project's name, or null where no project has the id. */
export async function findProjectName(projectId: string): Promise<string | null> {
  const [row] = await db
    .select({ name: projects.name })
    .from(projects)
    .where(eq(projects.id, projectId))
    .limit(1);
  return row?.name ?? null;
}
