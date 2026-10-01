import type { IssueStatus } from '../db/schema.js';
import {
  type LandingShape,
  landingRoute,
  landingShortfall,
  readLandingEvidence,
} from './landing-evidence.js';
import { type MergeMarkKind, type MergeRecordExecutor, mergeMarkKindOf } from './merge-record.js';

/** The status an issue stands at while its release is waiting to be pressed. */
export const BASE_MERGE_STATE: IssueStatus = 'awaiting_release';

/** What a refusal under the shipped-work rule says, or `null` where the call may proceed. */
export interface ShippedRuleRefusal {
  detail: string;
  details: Record<string, unknown>;
}

/** The sentence every close refusal carries, naming the route this project's shape has. */
export function closedMeansShipped(shape: LandingShape | null, held?: MergeMarkKind): string {
  return (
    '`closed` means the work shipped. Use `dropped` for work that turned out not to be work — ' +
    'a note, a question, a duplicate, something already done — which is terminal without the claim ' +
    `and releases every \`blocks\` dependent the same way. ${landingRoute(shape, held)}`
  );
}

// cm:flow release/close after:stamp — the close reads the stamp and the project's shape and refuses unless landing-evidence.ts accepts the mark; it no longer writes one, so an issue that never shipped cannot wear the status that says it did
export async function refuseUnshippedClose(
  executor: MergeRecordExecutor,
  args: { issueId: string; toStatus: IssueStatus },
): Promise<ShippedRuleRefusal | null> {
  if (args.toStatus !== 'closed') return null;
  const evidence = await readLandingEvidence(executor, args.issueId);
  if (evidence && !landingShortfall(evidence.columns, evidence.shape)) return null;
  if (!evidence || evidence.shape === 'git') {
    return {
      detail: `this issue carries no \`merged_at\`, so nothing on it shows the work shipped. ${closedMeansShipped('git')}`,
      details: { requires: 'mergedAt', useInstead: 'dropped' },
    };
  }
  const { columns, shape } = evidence;
  if (shape === null) {
    return {
      detail: `${landingShortfall(columns, shape)}. ${closedMeansShipped(shape)}`,
      details: { requires: 'sourceType', held: mergeMarkKindOf(columns), useInstead: 'dropped' },
    };
  }
  return {
    detail: `${landingShortfall(columns, shape)}, so nothing on it shows where the work landed. ${closedMeansShipped(shape, mergeMarkKindOf(columns))}`,
    details: {
      requires: 'mergedLanding',
      shape,
      held: mergeMarkKindOf(columns),
      useInstead: 'dropped',
    },
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
