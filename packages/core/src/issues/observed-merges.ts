// What the host reports of the issue's merges: a read of the repository projection, never a stamp,
// which `merge-record.ts` alone writes (`scripts/check-merged-at-writers.mjs`).

import { and, desc, eq, isNotNull, notInArray } from 'drizzle-orm';
import { repoPullRequestIssues, repoPullRequests } from '../db/schema-repo-projection.js';
import type { MergeRecordExecutor } from './merge-record.js';

/**
 * Every merge the host reports of a change request linking the issue, into `base` where named, with
 * the branch it merged into, latest first: an issue delivered across several requests lands at the
 * last. A link is what a request says it delivers, so a reader takes the first whose commit is the
 * issue's landing (`merge-identity.ts:identifiedMergeForIssue`), never the first alone.
 */
export async function observedMergesForIssue(
  executor: MergeRecordExecutor,
  issueId: string,
  base?: string,
  promotes: readonly string[] = [],
): Promise<Array<{ commitSha: string; mergedAt: Date; target: string }>> {
  const rows = await executor
    .select({
      sha: repoPullRequests.mergeCommitSha,
      at: repoPullRequests.mergedAt,
      base: repoPullRequests.baseRef,
    })
    .from(repoPullRequestIssues)
    .innerJoin(repoPullRequests, eq(repoPullRequests.id, repoPullRequestIssues.pullRequestId))
    .where(
      and(
        eq(repoPullRequestIssues.issueId, issueId),
        eq(repoPullRequests.state, 'merged'),
        isNotNull(repoPullRequests.mergeCommitSha),
        isNotNull(repoPullRequests.mergedAt),
        base === undefined ? undefined : eq(repoPullRequests.baseRef, base),
        // a promotion of landed work is nobody's landing (REQ-45 BC-16)
        promotes.length > 0 ? notInArray(repoPullRequests.headRef, [...promotes]) : undefined,
      ),
    )
    .orderBy(desc(repoPullRequests.mergedAt));
  return rows.flatMap((r) =>
    r.sha && r.at ? [{ commitSha: r.sha, mergedAt: r.at, target: r.base }] : [],
  );
}
