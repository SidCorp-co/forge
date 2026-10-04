import type { IssueDependencyKind, IssueStatus } from '../db/schema.js';
import { ISSUE_RESOLVED_STATUSES } from './status-sets.js';

export const WORK_EVIDENCE_WAIVER_KIND: IssueDependencyKind = 'decomposes';

export const WORK_EVIDENCE_WAIVER_NOTE =
  `It does not gate dispatch, but it is NOT inert: one live \`${WORK_EVIDENCE_WAIVER_KIND}\` edge ` +
  "OUT of an issue waives that issue's work-evidence gate, so it can be marked merged and moved " +
  'to a test step with no branch, no commit and no code handoff of its own. That ' +
  'exemption exists for grouping parents whose children carry the code; wiring one onto an issue ' +
  'that is meant to prove its own work removes the check that would have caught a fabricated ' +
  'merge.';

const NO_EFFECT_NOTE = 'Metadata only — it gates no dispatch and waives no evidence check.';

export const DISPATCH_GATING_KIND: IssueDependencyKind = 'blocks';

/** A blocker releases its dependents once every criterion it carries has passed (ISS-54): exactly
 *  when its issue is resolved, so this is `ISSUE_RESOLVED_STATUSES` under the name the dispatcher and
 *  the browser's copy read. A blocker that delivers a design revision also owes that revision
 *  approved (`design-delivery.ts`, FB-57), which no status says. */
export const BLOCKER_SETTLED_STATUSES: readonly IssueStatus[] = ISSUE_RESOLVED_STATUSES;

export const GATES_DISPATCH_NOTE =
  'B is held out of the admissible set a master reads, and refused ISSUE_BLOCKED to every claim of ' +
  'it while it has not started (a lease, a run session, a pool job, a move to `in_progress`), while a ' +
  'live `blocks` edge points at it ' +
  `from an A that has not reached \`${BLOCKER_SETTLED_STATUSES[0]}\` — the statuses that release ` +
  `it are ${BLOCKER_SETTLED_STATUSES.map((s) => `\`${s}\``).join(', ')}. A reopened A blocks ` +
  "again. A blocker that delivers a design revision (it is that revision's design issue, or the " +
  'latest verdict on one of its criteria names it) holds B until the revision is approved, whatever ' +
  'its status. Retracting the edge (`validUntil` in the past) stops it holding B here, and dropping A ' +
  'expires its edges for the same reason — but NOT yet at the master, whose own reading ignores ' +
  'expiry (forge-plugin ISS-347), so a B released that way is offered and then declined. Moving A ' +
  'forward is the route that works on both. `merged_at` is not what any of this reads: it is the ' +
  'stamp that says A landed, and no dispatch decision in Forge is gated on it.';

export type DependencyKindEffect = {
  gatesDispatch: boolean;
  waivesWorkEvidence: boolean;
  note: string;
};

/** What wiring an edge of this kind will actually do, for the caller that just wired it. */
export function describeDependencyKind(kind: IssueDependencyKind): DependencyKindEffect {
  if (kind === DISPATCH_GATING_KIND) {
    return { gatesDispatch: true, waivesWorkEvidence: false, note: GATES_DISPATCH_NOTE };
  }
  if (kind === WORK_EVIDENCE_WAIVER_KIND) {
    return { gatesDispatch: false, waivesWorkEvidence: true, note: WORK_EVIDENCE_WAIVER_NOTE };
  }
  return { gatesDispatch: false, waivesWorkEvidence: false, note: NO_EFFECT_NOTE };
}
