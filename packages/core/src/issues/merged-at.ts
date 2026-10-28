import {
  COMMIT_MAY_STAY_EMPTY,
  MARK_MERGED_ACTION,
  UNMARK_ACTION,
  WHERE_IT_LANDED_FIELD,
} from '@forge/contracts/mark-merged-words';
import type { IssueStatus } from '../db/schema.js';
import { namesNoRepository } from '../projects/live-source.js';
import {
  DECLARE_OUTSIDE_GIT,
  type Lane,
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

const CLOSE_INSTEAD = 'If it turned out not to be work, move it to Dropped instead.';

const UNMARK_FIRST = 'The first mark stands, so `unmark` it first with `forge_issues` `unmark`. ';

const MARK_WITH_COMMIT =
  'Mark it merged with `forge_issues` `mark_merged`, naming the commit it landed at in ' +
  '`data.commit` where there is one.';

const MARK_WITH_LANDING =
  'Mark it merged with `forge_issues` `mark_merged` carrying `data.landing`, the live URL, CMS ' +
  'entry or storefront resource the work now is.';

/**
 * A close with nothing showing the work shipped, in the same short sentences for a person and an
 * agent: what stands in the way, the one control that clears it, and Dropped for work that was not
 * work (ISS-1421 r16). An agent's door to the same act is a step in `details.steps`, which an MCP
 * caller reads on a line of its own.
 */
function unshippedWords(lane: Lane, held: MergeMarkKind, noRepository = false): ShippedRuleRefusal {
  if (lane.shape === 'git') {
    // A mark naming only a landing is no merge in git, and the first mark stands until it is taken back.
    const landed = held === 'landed';
    // A project naming no repository takes a mark naming no commit (ISS-1421 r41, criterion 393).
    const empty = noRepository
      ? [`${COMMIT_MAY_STAY_EMPTY.charAt(0).toUpperCase()}${COMMIT_MAY_STAY_EMPTY.slice(1)}.`]
      : [];
    return {
      detail: [
        landed
          ? "This issue can't close yet: its mark names a landing, not a merge in git."
          : "This issue can't close yet: it is not marked merged.",
        landed
          ? `Use ${UNMARK_ACTION}, then ${MARK_MERGED_ACTION} in the issue's properties.`
          : `Use ${MARK_MERGED_ACTION} in the issue's properties, then close it.`,
        ...empty,
        CLOSE_INSTEAD,
      ].join(' '),
      details: {
        requires: 'mergedAt',
        useInstead: 'dropped',
        ...(landed ? { held } : {}),
        steps: {
          merged_mark: `${landed ? UNMARK_FIRST : ''}${MARK_WITH_COMMIT}`,
          landing_shape: DECLARE_OUTSIDE_GIT,
        },
      },
    };
  }
  const asserted = held === 'asserted';
  return {
    detail: [
      asserted
        ? "This issue can't close yet: its mark does not say where the work landed."
        : "This issue can't close yet: it has no mark saying where the work landed.",
      asserted
        ? `Use ${UNMARK_ACTION}, then ${MARK_MERGED_ACTION}, and fill in ${WHERE_IT_LANDED_FIELD}.`
        : `Use ${MARK_MERGED_ACTION} in the issue's properties and fill in ${WHERE_IT_LANDED_FIELD}.`,
      CLOSE_INSTEAD,
    ].join(' '),
    details: {
      requires: 'mergedLanding',
      shape: lane.shape,
      declared: lane.declared,
      held,
      useInstead: 'dropped',
      steps: {
        merged_mark: `${asserted ? UNMARK_FIRST : ''}${MARK_WITH_LANDING}`,
      },
    },
  };
}

// cm:flow release/close after:stamp — the close reads the stamp and the issue's lane and refuses unless landing-evidence.ts accepts the mark; it no longer writes one, so an issue that never shipped cannot wear the status that says it did
export async function refuseUnshippedClose(
  executor: MergeRecordExecutor,
  args: {
    issueId: string;
    toStatus: IssueStatus;
    /** Whether the project names no repository, asked only once a git close is refused; the
     *  project's own answer where a caller has none to share. */
    noRepository?: (() => Promise<boolean>) | undefined;
  },
): Promise<ShippedRuleRefusal | null> {
  if (args.toStatus !== 'closed') return null;
  const evidence = await readLandingEvidence(executor, args.issueId);
  if (evidence && !landingShortfall(evidence.columns, evidence.lane)) return null;
  const lane: Lane = evidence?.lane ?? { shape: 'git', declared: false };
  const held = evidence ? mergeMarkKindOf(evidence.columns) : 'unmarked';
  const asked =
    args.noRepository ??
    (evidence?.projectId ? () => namesNoRepository(evidence.projectId) : undefined);
  const claim = lane.shape === 'git' && (await asked?.()) === true;
  return unshippedWords(lane, held, claim);
}

/** Why `unmark` is refused on a `closed` issue, or `null` where it may proceed. `clearIssueMerge`
 *  nulls `merged_at` and leaves `status` alone, so on a `closed` row it makes the one state this
 *  rule forbids. The trigger refuses it too, but names an entry into `closed` nobody attempted. */
export function refuseUnmarkOnClosed(status: IssueStatus): ShippedRuleRefusal | null {
  if (status !== 'closed') return null;
  return {
    detail:
      'This issue is Closed, and Closed means the work went out, so its mark cannot be taken ' +
      'back. Move it to Reopened first, then use Unmark. Where the work never landed, take ' +
      'Dropped from Reopened instead.',
    details: { status: 'closed', moveTo: 'reopen', useInstead: 'dropped' },
  };
}
