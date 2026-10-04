import type { IssueStatus } from '../db/schema.js';
import {
  type LandingShape,
  landingRoute,
  landingShortfall,
  readLandingEvidence,
} from './landing-evidence.js';
import { type MergeMarkKind, type MergeRecordExecutor, mergeMarkKindOf } from './merge-record.js';

/** What a refusal under the shipped-work rule says, or `null` where the call may proceed. */
export interface ShippedRuleRefusal {
  detail: string;
  details: Record<string, unknown>;
}

/** What every refusal under the merge rule ends with: `dropped` for what was not work, and the
 *  route this project's shape has for recording where the work landed. */
export function closedMeansShipped(shape: LandingShape | null, held?: MergeMarkKind): string {
  return (
    '`closed` means the work shipped, and `awaiting_release` that it is merged and waits for its ' +
    'release. Use `dropped` for work that turned out not to be work — a note, a question, a ' +
    'duplicate, something already done — which is terminal without the claim and releases every ' +
    `\`blocks\` dependent the same way. ${landingRoute(shape, held)}`
  );
}

/**
 * The `merged` guard (`@forge/contracts/issue-machine:ISSUE_MACHINE`): `awaiting_release` and
 * `closed` are entered only by an issue whose merge is recorded, as this project's shape records
 * one. Recording it moves no status. Null where the merge stands.
 */
export async function mergeNotRecorded(
  executor: MergeRecordExecutor,
  args: { issueId: string; to: IssueStatus },
): Promise<
  (ShippedRuleRefusal & { code: 'CLOSE_REQUIRES_SHIPPED' | 'MERGE_NOT_RECORDED' }) | null
> {
  const code = args.to === 'closed' ? 'CLOSE_REQUIRES_SHIPPED' : 'MERGE_NOT_RECORDED';
  const evidence = await readLandingEvidence(executor, args.issueId);
  if (evidence && !landingShortfall(evidence.columns, evidence.shape)) return null;
  if (!evidence || evidence.shape === 'git') {
    return {
      code,
      detail: `\`${args.to}\` needs a recorded merge, and this issue carries no \`merged_at\`. ${closedMeansShipped('git')}`,
      details: { to: args.to, requires: 'mergedAt', useInstead: 'dropped' },
    };
  }
  const { columns, shape } = evidence;
  if (shape === null) {
    return {
      code,
      detail: `${landingShortfall(columns, shape)}. ${closedMeansShipped(shape)}`,
      details: {
        to: args.to,
        requires: 'sourceType',
        held: mergeMarkKindOf(columns),
        useInstead: 'dropped',
      },
    };
  }
  return {
    code,
    detail: `${landingShortfall(columns, shape)}, so nothing on it shows where the work landed. ${closedMeansShipped(shape, mergeMarkKindOf(columns))}`,
    details: {
      to: args.to,
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
