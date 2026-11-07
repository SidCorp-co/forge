import type { ReadPaths } from '@forge/contracts/landing-artifacts';
// What memory reads of issues and their activity, handed to it through `memory/ports.ts` at boot.
import { and, desc, eq, gte, isNull, type SQL, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { activityLog, issues, projects } from '../db/schema.js';
import { formatIssueRef } from '../lib/issue-ref.js';
import { resolveSourceHost } from './ports.js';

/** The issue's current title, body and the two facts memory carries; archived or not. */
export async function issueHead(issueId: string) {
  const [row] = await db
    .select({
      title: issues.title,
      description: issues.description,
      descriptionFormat: issues.descriptionFormat,
      priority: issues.priority,
      category: issues.category,
    })
    .from(issues)
    .where(eq(issues.id, issueId))
    .limit(1);
  return row ?? null;
}

/** The issue in this project, unarchived, with its project's prefix. */
export async function releasedIssueOf(projectId: string, issueId: string) {
  const [row] = await db
    .select({
      issSeq: issues.issSeq,
      issuePrefix: projects.issuePrefix,
      title: issues.title,
      description: issues.description,
      plan: issues.plan,
      releaseNotes: issues.releaseNotes,
      mergedAt: issues.mergedAt,
    })
    .from(issues)
    .innerJoin(projects, eq(projects.id, issues.projectId))
    .where(and(eq(issues.id, issueId), eq(issues.projectId, projectId), isNull(issues.archivedAt)))
    .limit(1);
  return row ?? null;
}

/**
 * What a landing changed, as memory's re-check reads it (REQ-89 BC-5, ISS-1121): the issue's key,
 * its text, and the paths its landed commit changed — the paths the box read at that commit, else
 * the project's source host at it — or why none were read.
 */
export async function landedChangeOf(projectId: string, issueId: string) {
  const issue = await releasedIssueOf(projectId, issueId);
  if (!issue) return null;
  const [row] = await db
    .select({ commit: issues.mergedCommitSha, read: issues.mergedPaths })
    .from(issues)
    .where(eq(issues.id, issueId))
    .limit(1);
  const key = formatIssueRef(issue.issuePrefix, issue.issSeq);
  const text = [
    issue.title,
    issue.description,
    issue.plan,
    issue.releaseNotes?.userFacing,
    issue.releaseNotes?.technical,
  ]
    .filter((t): t is string => Boolean(t?.trim()))
    .join('\n\n');
  return { key, text, ...(await landedPaths(projectId, row?.commit ?? null, row?.read ?? null)) };
}

async function landedPaths(
  projectId: string,
  commit: string | null,
  read: ReadPaths | null,
): Promise<{ paths: string[] | null; why?: string }> {
  if (read && (commit === null || sameCommitPrefix(read.commit, commit))) {
    return { paths: read.changes.map((c) => c.path) };
  }
  if (!commit) return { paths: null, why: 'the landing names no commit and no paths' };
  try {
    const host = await resolveSourceHost(projectId, 'kernel');
    const files = await host.commitFiles(commit);
    return 'why' in files ? { paths: null, why: files.why } : { paths: [...files.files] };
  } catch (err) {
    return { paths: null, why: err instanceof Error ? err.message : String(err) };
  }
}

const sameCommitPrefix = (a: string, b: string) => {
  const [x, y] = [a.toLowerCase(), b.toLowerCase()];
  return x.startsWith(y) || y.startsWith(x);
};

/** The project's status changes on unarchived issues since `since`, newest first. */
export function statusChangesSince(projectId: string, since: Date, limit: number) {
  return db
    .select({ payload: activityLog.payload, issueTitle: issues.title })
    .from(activityLog)
    .innerJoin(issues, and(eq(activityLog.issueId, issues.id), isNull(issues.archivedAt)))
    .where(
      and(
        eq(issues.projectId, projectId),
        eq(activityLog.action, 'issue.statusChanged'),
        gte(activityLog.createdAt, since),
      ),
    )
    .orderBy(desc(activityLog.createdAt))
    .limit(limit);
}

/**
 * A subquery yielding the project's archived issue ids as text. `NOT IN` over it is a hashed
 * subplan, evaluated once per query rather than once per outer row.
 */
export function archivedIssueIdsSql(projectId: string): SQL {
  return sql`(SELECT ${issues.id}::text FROM ${issues} WHERE ${issues.projectId} = ${projectId} AND ${issues.archivedAt} IS NOT NULL)`;
}
