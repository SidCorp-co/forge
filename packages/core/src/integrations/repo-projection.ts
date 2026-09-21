import { inArray, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { type PullRequestState, repoPullRequests } from '../db/schema-repo-projection.js';
import { type CheckRollup, rollupOf } from './github/projection-shape.js';

export interface IssuePullRequest {
  number: number;
  repo: string;
  url: string | null;
  title: string;
  state: PullRequestState;
  draft: boolean;
  headRef: string;
  headSha: string;
  baseRef: string;
  /** Commits on the base that this head does not have, or null where no read has answered. */
  behindBy: number | null;
  aheadBy: number | null;
  /** GitHub's own verdict: `clean`, `dirty`, `behind`, `blocked`, `unstable`, `unknown`, or null. */
  mergeableState: string | null;
  /** The head `behindBy`, `aheadBy` and `mergeableState` describe. Null where nothing has. */
  refreshedForHead: string | null;
  /** Why the last read could not answer, or null. An absence with a reason beside it. */
  refreshError: string | null;
  /** Counted over the current head's runs only. */
  checks: CheckRollup;
  reviews: Array<{ id: string; reviewer: string; state: string; submittedAt: string | null }>;
  mergedAt: string | null;
  mergeCommitSha: string | null;
}

const ORDER = sql`(${repoPullRequests.state} <> 'open'), ${repoPullRequests.number} DESC`;

export async function readPullRequestsForIssues(
  issueIds: string[],
): Promise<Map<string, IssuePullRequest[]>> {
  const out = new Map<string, IssuePullRequest[]>();
  if (issueIds.length === 0) return out;

  const rows = await db
    .select()
    .from(repoPullRequests)
    .where(inArray(repoPullRequests.issueId, issueIds))
    .orderBy(ORDER);

  for (const row of rows) {
    if (!row.issueId) continue;
    const list = out.get(row.issueId) ?? [];
    list.push({
      number: row.number,
      repo: row.repoFullName,
      url: row.htmlUrl,
      title: row.title,
      state: row.state,
      draft: row.draft,
      headRef: row.headRef,
      headSha: row.headSha,
      baseRef: row.baseRef,
      behindBy: row.behindBy,
      aheadBy: row.aheadBy,
      mergeableState: row.mergeableState,
      refreshedForHead: row.refreshedForHead,
      refreshError: row.refreshError,
      checks: rollupOf(row.checks ?? {}, row.headSha),
      reviews: Object.values(row.reviews ?? {})
        .filter((r) => !r.dismissed)
        .map((r) => ({
          id: r.id,
          reviewer: r.reviewer,
          state: r.state,
          submittedAt: r.submittedAt ?? null,
        }))
        .sort((a, b) => (a.submittedAt ?? '').localeCompare(b.submittedAt ?? '')),
      mergedAt: row.mergedAt ? row.mergedAt.toISOString() : null,
      mergeCommitSha: row.mergeCommitSha,
    });
    out.set(row.issueId, list);
  }
  return out;
}
