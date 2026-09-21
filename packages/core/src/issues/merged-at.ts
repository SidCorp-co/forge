import type { IssueStatus } from '../db/schema.js';
import { type MergeRecordExecutor, recordIssueMerge } from './merge-record.js';

/** The status an issue stands at while its release is waiting to be pressed. */
export const BASE_MERGE_STATE: IssueStatus = 'awaiting_release';

// cm:flow release/close after:stamp — closing stamps merged_at when it is still null, which is why closing an issue that was never work unblocks its dependents as if it had shipped; unmark is the only reversal
export async function markMergedOnClose(
  executor: MergeRecordExecutor,
  args: { issueId: string; toStatus: IssueStatus },
): Promise<{ stamped: boolean }> {
  if (args.toStatus !== 'closed') return { stamped: false };
  const record = await recordIssueMerge(executor, {
    issueId: args.issueId,
    evidence: { kind: 'asserted', via: 'close' },
  });
  return { stamped: record.wrote };
}
