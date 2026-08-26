import { and, desc, eq, gt, inArray } from 'drizzle-orm';
import {
  type BranchConfig,
  extractIssueBranchOverride,
  resolveIssueBranches,
} from '../branches/resolve.js';
import { db } from '../db/client.js';
import { issues, jobs, projects } from '../db/schema.js';
import type { IssueSnapshot, SessionContextSnapshot } from './user.js';

export type LoadedIssueSnapshot = IssueSnapshot & { branchConfig: BranchConfig };

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
): Promise<LoadedIssueSnapshot | null> {
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
      metadata: issues.metadata,
      baseBranch: projects.baseBranch,
      productionBranch: projects.productionBranch,
    })
    .from(issues)
    .innerJoin(projects, eq(projects.id, issues.projectId))
    .where(
      projectId
        ? and(eq(issues.id, issueId), eq(issues.projectId, projectId))
        : eq(issues.id, issueId),
    )
    .limit(1);
  if (!row) return null;

  const ctx = (row.sessionContext ?? null) as SessionContextSnapshot | null;
  const branchConfig = resolveIssueBranches(
    {
      metadata: {
        branchConfig: extractIssueBranchOverride(
          row as Parameters<typeof extractIssueBranchOverride>[0],
        ),
      },
    },
    { baseBranch: row.baseBranch, productionBranch: row.productionBranch },
  );
  return {
    branchConfig,
    supersededBy: await countStepsSince(issueId, ctx?.lastUpdated ?? null),
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

/**
 * Steps that finished AFTER the sessionContext snapshot was written (ISS-699).
 *
 * The snapshot is agent-authored — a prompt line asks each step to refresh it,
 * and a step that skips leaves the previous narrative in place. Later steps then
 * read a verdict describing a state that no longer exists. On ISS-698 a release
 * step read a FAIL narrative written before the fix, re-review, re-merge and a
 * PASSING re-test, and bounced an already-verified issue back to `reopen`.
 *
 * Freshness is therefore measured here rather than trusted: a count the reader
 * cannot forget to check, computed from the jobs ledger.
 */
async function countStepsSince(
  issueId: string,
  lastUpdated: string | null,
): Promise<{ count: number; latestType: string; latestFinishedAt: string } | null> {
  if (!lastUpdated) return null;
  const since = new Date(lastUpdated);
  if (Number.isNaN(since.getTime())) return null;

  const rows = await db
    .select({ type: jobs.type, finishedAt: jobs.finishedAt })
    .from(jobs)
    .where(
      and(
        eq(jobs.issueId, issueId),
        inArray(jobs.status, ['done', 'failed']),
        gt(jobs.finishedAt, since),
      ),
    )
    .orderBy(desc(jobs.finishedAt));

  const latest = rows[0];
  if (!latest?.finishedAt) return null;
  return {
    count: rows.length,
    latestType: latest.type,
    latestFinishedAt: latest.finishedAt.toISOString(),
  };
}
