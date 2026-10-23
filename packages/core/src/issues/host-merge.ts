import { and, eq } from 'drizzle-orm';
import type { Tx } from '../db/client.js';
import { repoPullRequestIssues, repoPullRequests } from '../db/schema-repo-projection.js';
import { consume } from '../outbox/index.js';
import { resolveIssuesForChangeRequest } from './head-ref-link.js';
import { recordIssueMerge } from './merge-record.js';
import { projectCreatorOf } from './ports.js';

/**
 * Every issue the merged branch delivers: each one Forge's record of its change request links, and
 * each one the branch name itself names, for a request the projection has not read yet (REQ-63 BC-4).
 */
async function issuesDelivered(executor: Tx, projectId: string, headRef: string) {
  const linked = await executor
    .selectDistinct({ issueId: repoPullRequestIssues.issueId })
    .from(repoPullRequestIssues)
    .innerJoin(repoPullRequests, eq(repoPullRequests.id, repoPullRequestIssues.pullRequestId))
    .where(and(eq(repoPullRequests.projectId, projectId), eq(repoPullRequests.headRef, headRef)));
  const named = await resolveIssuesForChangeRequest({ projectId, headRef });
  return [...new Set([...linked.map((r) => r.issueId), ...named.map((l) => l.issueId)])];
}

/**
 * The merge a source host reports, on the row the kernel's own merge writes: the one stamp for GitHub
 * and GitLab alike. Somebody pressing Merge on the host and Forge merging are one landing arriving by
 * two routes, and they produce one record because both write through `recordIssueMerge` under
 * `merged_commit_sha IS NULL`. It records the merge on every issue the request delivers and moves no
 * status; a change-request release it was the last merge of is closed by the release's own consumer
 * (`release-batch/change-request-merge.ts`). Answers which issues this call stamped.
 */
async function stampHostMerge(
  args: {
    projectId: string;
    headRef: string;
    commitSha: string;
    mergedAt: Date;
  },
  executor: Tx,
): Promise<string[]> {
  if (Number.isNaN(args.mergedAt.getTime())) {
    throw new Error(
      `source.merged for ${args.headRef} carries a mergedAt that is not a time; the merge stamp is kernel evidence and is not written without one`,
    );
  }
  const delivered = await issuesDelivered(executor, args.projectId, args.headRef);
  const creator = await projectCreatorOf(args.projectId);
  const stamped: string[] = [];
  for (const issueId of delivered) {
    const stamp = await recordIssueMerge(executor, {
      issueId,
      via: 'event',
      // a host-reported merge is recorded on the project owner's behalf, as the review note is
      actor: creator ? { type: 'user', id: creator, agency: 'agent' } : null,
      evidence: {
        kind: 'observed',
        commitSha: args.commitSha,
        mergedAt: args.mergedAt,
      },
    });
    if (stamp.wrote) stamped.push(issueId);
  }
  return stamped;
}

/** The issues kernel's reaction to a merge a source host reported. */
export function registerHostMergeStamp(): void {
  consume('source.merged', {
    name: 'issue-merge-stamp',
    handle: async (p, d) => {
      await d.inbox((tx) => stampHostMerge({ ...p, mergedAt: new Date(p.mergedAt) }, tx));
    },
  });
}
