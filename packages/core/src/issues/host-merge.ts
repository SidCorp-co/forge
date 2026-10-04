import { db } from '../db/client.js';
import { consume } from '../outbox/index.js';
import { resolveIssueForHeadRef } from './head-ref-link.js';
import { type MergeRecordExecutor, recordIssueMerge } from './merge-record.js';

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
  executor: MergeRecordExecutor = db,
): Promise<boolean> {
  if (Number.isNaN(args.mergedAt.getTime())) return false;
  const issueId = await resolveIssueForHeadRef({
    projectId: args.projectId,
    headRef: args.headRef,
  });
  if (!issueId) return false;
  const stamp = await recordIssueMerge(executor, {
    issueId,
    evidence: {
      kind: 'observed',
      commitSha: args.commitSha,
      mergedAt: args.mergedAt,
      via: 'event',
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
