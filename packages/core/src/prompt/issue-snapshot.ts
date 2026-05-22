import { eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { issues } from '../db/schema.js';
import type { IssueSnapshot, SessionContextSnapshot } from './user.js';

/**
 * Pre-load issue fields used by `buildJobPromptString` to inline an
 * `## Issue` block + sessionContext preamble into the runner prompt.
 * Single SELECT; per-state field gating happens inside `prompt/user.ts`.
 */
export async function loadIssueSnapshot(issueId: string): Promise<IssueSnapshot | null> {
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
    .where(eq(issues.id, issueId))
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
