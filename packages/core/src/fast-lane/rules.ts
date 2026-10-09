// The fast lane's rules, pure (REQ-39 BC-7, BC-8; docs/proposals/live-preview.md, "Fast lane"): when
// a merge check on the fast lane may stand for an issue, which lane an issue's approved change takes,
// and when a web-only deploy may ship the commits between what web serves and the new head. Each
// refusal names what failed: the declaration, the approval, the patch, or the file and the rule
// that caught it. The lane itself is the contract's `classifyLane`, never restated here.

import {
  classifyLane,
  type FastLaneRefusalCode,
  type FastLaneSettings,
  type FullLaneCause,
  type Lane,
  type LaneDecision,
} from '@forge/contracts/fast-lane';
import type { MergeCheckReport } from '@forge/contracts/merge-check';
import type { ApprovedPreview } from './ports.js';

export interface FastLaneRefusal {
  code: FastLaneRefusalCode;
  path: string;
  detail: string;
}

/** At most this many causes are spelled out in one refusal; the rest are counted. */
const CAUSES_SHOWN = 8;

/** Each file the full lane caught, with the area and the glob that caught it. */
export function causesSaid(causes: readonly FullLaneCause[]): string {
  const said = causes.slice(0, CAUSES_SHOWN).map((c) => {
    if (c.file === null) {
      return c.area === 'no-files'
        ? 'it touches no file'
        : 'the project declares no `fastLane.paths`';
    }
    if (c.area === 'outside-fast-paths') {
      return `${c.file} (outside \`fastLane.paths\`: a web-only deploy does not ship it)`;
    }
    return `${c.file} (${c.area}: \`${c.glob}\`)`;
  });
  const more = causes.length > CAUSES_SHOWN ? `; +${causes.length - CAUSES_SHOWN} more` : '';
  return `${said.join('; ')}${more}`;
}

const undeclared = (path: string, why: string): FastLaneRefusal => ({
  code: 'FAST_LANE_UNDECLARED',
  path,
  detail: why,
});

const NO_DECLARATION =
  'the project document declares no `fastLane` (`paths`, `deployTargets`), so every change takes the full lane';

/**
 * Why a fast-lane merge check may not stand for this issue, or null: the project declares no fast
 * lane, no preview of the issue was approved, the change checked is not the change approved (its
 * patch id differs), or a file it touches is not fast. The first fault answers.
 */
export function fastMergeRefusal(args: {
  issueRef: string;
  report: Pick<MergeCheckReport, 'patchId' | 'touched' | 'head'>;
  settings: FastLaneSettings | null;
  approval: { approved: ApprovedPreview | null } | { unread: string };
}): FastLaneRefusal | null {
  const { issueRef, report, settings, approval } = args;
  const fullCheck = 'run the full merge check (without `--lane fast`). Nothing was recorded';
  if (!settings) return undeclared('/lane', `${NO_DECLARATION}: ${fullCheck}`);
  if ('unread' in approval || approval.approved === null) {
    const why = 'unread' in approval ? approval.unread : `${issueRef} has no approved live preview`;
    return {
      code: 'FAST_LANE_NOT_APPROVED',
      path: '/lane',
      detail: `${why}, and only a change a person approved in its preview takes the fast lane: have the preview approved, or ${fullCheck}`,
    };
  }
  const { approved } = approval;
  if (report.patchId !== approved.patchId) {
    return {
      code: 'FAST_LANE_CHANGED_SINCE_APPROVAL',
      path: '/patchId',
      detail: `the preview approved at ${approved.approvedAt} served patch ${approved.patchId}, and this report checked patch ${report.patchId ?? '(none)'} at ${report.head.slice(0, 12)}: the change moved after it was approved. Open the preview again and have this change approved, or ${fullCheck}`,
    };
  }
  const decision = classifyLane(
    report.touched.map((t) => t.path),
    settings,
  );
  if (decision.lane === 'full') {
    return {
      code: 'FAST_LANE_NOT_ELIGIBLE',
      path: '/touched',
      detail: `this change touches what the fast lane never takes: ${causesSaid(decision.causes)}; ${fullCheck}`,
    };
  }
  return null;
}

/** The lane an issue's change takes, and why, as `GET /api/issues/:id/lane` answers it. */
export interface IssueLane {
  lane: Lane;
  /** `classifyLane` over the approved preview's files; null where nothing was approved or declared. */
  decision: LaneDecision | null;
  approved: ApprovedPreview | null;
  /** Why the change is on the full lane; null on the fast lane. */
  refusal: FastLaneRefusal | null;
}

export function issueLaneOf(args: {
  issueRef: string;
  settings: FastLaneSettings | null;
  approval: { approved: ApprovedPreview | null } | { unread: string };
}): IssueLane {
  const { issueRef, settings, approval } = args;
  const approved = 'approved' in approval ? approval.approved : null;
  if (!settings) {
    return { lane: 'full', decision: null, approved, refusal: undeclared('/lane', NO_DECLARATION) };
  }
  if (!approved) {
    const why = 'unread' in approval ? approval.unread : `${issueRef} has no approved live preview`;
    return {
      lane: 'full',
      decision: null,
      approved,
      refusal: {
        code: 'FAST_LANE_NOT_APPROVED',
        path: '/lane',
        detail: `${why}; only a change a person approved in its preview takes the fast lane`,
      },
    };
  }
  const decision = classifyLane(approved.files, settings);
  if (decision.lane === 'fast') return { lane: 'fast', decision, approved, refusal: null };
  return {
    lane: 'full',
    decision,
    approved,
    refusal: {
      code: 'FAST_LANE_NOT_ELIGIBLE',
      path: '/files',
      detail: `the approved change touches what the fast lane never takes: ${causesSaid(decision.causes)}`,
    },
  };
}

/**
 * Why a web-only deploy may not name these targets, or null: the project declares no fast lane, a
 * label is not one of its `deployTargets`, or the binding holds no target by that label.
 */
export function deployTargetsRefusal(args: {
  settings: FastLaneSettings | null;
  labels: readonly string[];
  bound: readonly string[];
}): FastLaneRefusal | null {
  const { settings, labels, bound } = args;
  if (!settings) {
    return undeclared(
      '/targets',
      `${NO_DECLARATION}, and a web-only deploy is the fast lane's: deploy without \`targets\`, which deploys every one`,
    );
  }
  const undeclaredLabels = labels.filter((l) => !settings.deployTargets.includes(l));
  if (undeclaredLabels.length) {
    return undeclared(
      '/targets',
      `${undeclaredLabels.map((l) => `"${l}"`).join(', ')} is not among \`fastLane.deployTargets\` (${settings.deployTargets.map((l) => `"${l}"`).join(', ')}), the only targets a web-only deploy reaches`,
    );
  }
  const unbound = labels.filter((l) => !bound.includes(l));
  if (unbound.length) {
    return undeclared(
      '/targets',
      `the deploy binding holds no target labelled ${unbound.map((l) => `"${l}"`).join(', ')}; it holds ${bound.map((l) => `"${l}"`).join(', ') || 'none'}. Label the web target on the binding as \`fastLane.deployTargets\` names it`,
    );
  }
  return null;
}

/** One commit between what a target serves and the new head, with the files it changed. */
export interface RangeCommit {
  sha: string;
  files: readonly string[];
}

/**
 * Why a web-only deploy may not ship `served..head`, or null: a commit in the range is not fast, so
 * web would go out ahead of the change it needs (REQ-39 BC-7 web-only deploy guard). A commit that
 * changes no file ships nothing and is passed over; every other is classified on its own files.
 */
export function deployRangeRefusal(args: {
  settings: FastLaneSettings;
  label: string;
  served: string;
  head: string;
  commits: readonly RangeCommit[];
}): FastLaneRefusal | null {
  const { settings, label, served, head, commits } = args;
  const offenders = commits.flatMap((c) => {
    if (c.files.length === 0) return [];
    const decision = classifyLane(c.files, settings);
    return decision.lane === 'full'
      ? [`${c.sha.slice(0, 12)}: ${causesSaid(decision.causes)}`]
      : [];
  });
  if (offenders.length === 0) return null;
  return {
    code: 'FAST_LANE_NOT_ELIGIBLE',
    path: '/targets',
    detail: `a web-only deploy of "${label}" would ship ${served.slice(0, 12)}..${head.slice(0, 12)}, and ${offenders.length} of its ${commits.length} commit(s) are not fast — ${offenders.join(' | ')}. Web would go out ahead of a change it needs: deploy every target (no \`targets\`). Nothing was deployed`,
  };
}
