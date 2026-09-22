import { eq } from 'drizzle-orm';
import { type IssueStatus, issues } from '../db/schema.js';
import type { MergeRecordExecutor } from './merge-record.js';

/** The status an issue stands at while its release is waiting to be pressed. */
export const BASE_MERGE_STATE: IssueStatus = 'awaiting_release';

/** What a refusal under the shipped-work rule says, or `null` where the call may proceed. */
export interface ShippedRuleRefusal {
  detail: string;
  details: Record<string, unknown>;
}

export const CLOSED_MEANS_SHIPPED =
  '`closed` means the work shipped. Use `dropped` for work that turned out not to be work — ' +
  'a note, a question, a duplicate, something already done — which is terminal without the claim ' +
  'and releases every `blocks` dependent the same way. Where the work DID land outside the ' +
  'pipeline, claim it first with `forge_issues` `mark_merged` naming where it landed, then close.';

// cm:flow release/close after:stamp — the close reads the stamp and refuses without it; it no longer writes one, so an issue that never shipped cannot wear the status that says it did
export async function refuseUnshippedClose(
  executor: MergeRecordExecutor,
  args: { issueId: string; toStatus: IssueStatus },
): Promise<ShippedRuleRefusal | null> {
  if (args.toStatus !== 'closed') return null;
  const [row] = await executor
    .select({ mergedAt: issues.mergedAt })
    .from(issues)
    .where(eq(issues.id, args.issueId))
    .limit(1);
  if (row?.mergedAt) return null;
  return {
    detail: `this issue carries no \`merged_at\`, so nothing on it shows the work shipped. ${CLOSED_MEANS_SHIPPED}`,
    details: { requires: 'mergedAt', useInstead: 'dropped' },
  };
}

/** Why `unmark` is refused on a `closed` issue, or `null` where it may proceed. `clearIssueMerge`
 *  nulls `merged_at` and leaves `status` alone, so on a `closed` row it makes the one state this
 *  rule forbids. The trigger refuses it too, but names an entry into `closed` nobody attempted. */
export function refuseUnmarkOnClosed(status: IssueStatus): ShippedRuleRefusal | null {
  if (status !== 'closed') return null;
  return {
    detail:
      'this issue is `closed`, and `closed` means the work shipped, so the claim cannot be ' +
      'withdrawn while it stands there: clearing `merged_at` would leave a closed issue with ' +
      'nothing on it saying anything shipped. Move it off `closed` first — `reopen` is the only ' +
      'exit `closed` has — and then `unmark`, or take `dropped` from `reopen` where the work ' +
      'never landed at all.',
    details: { status: 'closed', moveTo: 'reopen', useInstead: 'dropped' },
  };
}
