/**
 * Reading the repository projection, for callers that do not know a provider.
 *
 * `devices/admissible.ts` and the pool ask this. They must not name github: the
 * provider-literal gate refuses a provider name outside `integrations/<provider>/`,
 * the registry and the schema — and the deeper reason is the same one the gate
 * exists for. What a master needs to know is whether this issue's change is
 * green and waiting or conflicting, which is a question about a repository and
 * not about which integration filled the row in.
 */

import { inArray, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { type PullRequestState, repoPullRequests } from '../db/schema-repo-projection.js';
import { type CheckRollup, rollupOf } from './github/projection-shape.js';

/**
 * One pull request as a master reads it.
 *
 * Raw throughout: a count, a state and a head, never a `ready`, `blocked` or
 * `satisfied`. Deciding what the numbers mean is the master's judgement, and a
 * payload that pre-answers it is the kernel routing through a second door —
 * `devices/admissible.ts` carries the same rule for `merged_at` and ISS-940 is
 * what it cost to learn.
 */
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
  /** Reviewers whose review is neither dismissed nor stale, by their last state. */
  reviews: Array<{ reviewer: string; state: string }>;
  mergedAt: string | null;
  mergeCommitSha: string | null;
}

// cm:guard open BEFORE closed and merged, then highest number first — an issue carrying a merged predecessor beside an open replacement is the ordinary case, both are returned, and the one a master is deciding about is the open one. Any order at all is required: an unordered read makes two calls disagree about which row is first, and a caller reading `[0]` would see a different pull request between one poll and the next.
const ORDER = sql`(${repoPullRequests.state} <> 'open'), ${repoPullRequests.number} DESC`;

/**
 * Every pull request linked to each of these issues.
 *
 * Returns a map so a caller that read a page of issues spends one query rather
 * than one per row. An issue with none is absent from the map, which the caller
 * renders as an empty list — never as null, because null and "none" would be
 * the same answer for "no pull request" and "the projection is not built here",
 * and those are different facts.
 */
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
        .map((r) => ({ reviewer: r.reviewer, state: r.state })),
      mergedAt: row.mergedAt ? row.mergedAt.toISOString() : null,
      mergeCommitSha: row.mergeCommitSha,
    });
    out.set(row.issueId, list);
  }
  return out;
}
