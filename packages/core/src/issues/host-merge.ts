import type { Tx } from '../db/client.js';
import { consume } from '../outbox/index.js';
import { resolveIssueForHeadRef } from './head-ref-link.js';
import { recordIssueMerge } from './merge-record.js';
import { projectCreatorOf } from './ports.js';

/**
 * The merge a source host reports, on the row the kernel's own merge writes: the one stamp for GitHub
 * and GitLab alike. Somebody pressing Merge on the host and Forge merging are one landing arriving by
 * two routes, and they produce one record because both write through `recordIssueMerge` under
 * `merged_commit_sha IS NULL`. It records the merge and moves no status. Answers whether this call
 * wrote the stamp.
 */
async function stampHostMerge(
  args: {
    projectId: string;
    headRef: string;
    commitSha: string;
    mergedAt: Date;
  },
  executor: Tx,
): Promise<boolean> {
  if (Number.isNaN(args.mergedAt.getTime())) {
    throw new Error(
      `source.merged for ${args.headRef} carries a mergedAt that is not a time; the merge stamp is kernel evidence and is not written without one`,
    );
  }
  const issueId = await resolveIssueForHeadRef({
    projectId: args.projectId,
    headRef: args.headRef,
  });
  if (!issueId) return false;
  const creator = await projectCreatorOf(args.projectId);
  const stamp = await recordIssueMerge(executor, {
    issueId,
    // a host-reported merge is recorded on the project owner's behalf, as the review note is
    actor: creator ? { type: 'user', id: creator, agency: 'agent' } : null,
    evidence: {
      kind: 'observed',
      commitSha: args.commitSha,
      mergedAt: args.mergedAt,
    },
  });
  return stamp.wrote;
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
