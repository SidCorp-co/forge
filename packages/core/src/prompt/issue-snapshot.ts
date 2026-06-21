import { and, eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { issues } from '../db/schema.js';
import type { IssueSnapshot, SessionContextSnapshot } from './user.js';

/**
 * Pre-load issue fields used by `buildJobPromptString` to inline an
 * `## Issue` block + sessionContext preamble into the runner prompt.
 * Single SELECT; per-state field gating happens inside `prompt/user.ts`.
 *
 * When `projectId` is supplied the lookup is scoped to that project
 * (`AND issues.project_id = projectId`), so a caller-supplied issueId from a
 * different project resolves to null — the tenant-isolation gate for the
 * `POST /api/prompt/preview` route (ISS-492). Trusted internal callers (the
 * pipeline orchestrator) omit it: they already resolved the issue's own
 * project, so no cross-project read is possible there.
 */
export async function loadIssueSnapshot(
  issueId: string,
  projectId?: string,
): Promise<IssueSnapshot | null> {
  const [row] = await db
    .select({
      title: issues.title,
      status: issues.status,
      priority: issues.priority,
      complexity: issues.complexity,
      description: issues.description,
      plan: issues.plan,
      acceptanceCriteria: issues.acceptanceCriteria,
      sessionContext: issues.sessionContext,
    })
    .from(issues)
    .where(
      projectId
        ? and(eq(issues.id, issueId), eq(issues.projectId, projectId))
        : eq(issues.id, issueId),
    )
    .limit(1);
  if (!row) return null;
  return {
    title: row.title,
    status: row.status,
    priority: row.priority,
    complexity: row.complexity,
    description: row.description,
    plan: row.plan,
    acceptanceCriteria: row.acceptanceCriteria,
    sessionContext: (row.sessionContext ?? null) as SessionContextSnapshot | null,
  };
}
