/**
 * ISS-935 — what each `issueDependencyKinds` value ACTUALLY does, in one place.
 *
 * Three agent-facing documents said `decomposes` was inert while
 * `pipeline/work-evidence.ts#hasChildIssues` read exactly that kind to waive
 * the ISS-786 anti-fabrication gate. So an agent wired a decompose believing
 * the write was a grouping label and silently waived the strongest evidence
 * gate in the pipeline. This module is the single string those documents and
 * that query now share, so the claim and the behaviour cannot drift again.
 */

import type { IssueDependencyKind, IssueStatus } from '../db/schema.js';

// cm:guard the ONE kind `hasChildIssues` reads. Changing it moves the waiver to a different edge, so every surface naming `decomposes` has to move with it — `dependency-effects.test.ts` reads the source of the surfaces that cannot interpolate this constant and goes red naming the file that did not follow.
// cm:edge lockstep -> packages/core/src/pipeline/work-evidence.ts — that query must filter on THIS constant and never a literal
// cm:edge lockstep -> packages/core/src/db/schema.ts — the `issueDependencyKinds` cm:guard names this kind as the exception to "no dispatch path reads a non-blocks kind"
// cm:edge lockstep -> docs/modules/issue-work/README.md — the Guards section names this kind
export const WORK_EVIDENCE_WAIVER_KIND: IssueDependencyKind = 'decomposes';

// cm:edge contract -> packages/core/src/guides/registry.ts — rendered verbatim into the `issue-dependencies` guide
// cm:edge contract -> packages/core/src/prompt/facts/registry.ts — rendered verbatim into the `relations` fact
// cm:edge contract -> packages/core/src/mcp/tools/forge-pm-set-dependency.ts — rendered verbatim into the tool description
// cm:edge contract -> packages/core/src/mcp/tools/forge-project-pm.ts — rendered verbatim into the `set_dependency` action text
export const WORK_EVIDENCE_WAIVER_NOTE =
  `It does not gate dispatch, but it is NOT inert: one live \`${WORK_EVIDENCE_WAIVER_KIND}\` edge ` +
  "OUT of an issue waives that issue's work-evidence gate, so it can be marked merged and moved " +
  'to `developed`/`testing` with no branch, no commit and no code handoff of its own. That ' +
  'exemption exists for grouping parents whose children carry the code; wiring one onto an issue ' +
  'that is meant to prove its own work removes the check that would have caught a fabricated ' +
  'merge.';

const NO_EFFECT_NOTE = 'Metadata only — it gates no dispatch and waives no evidence check.';

// cm:guard the ONE kind any dispatch decision reads, and `admissible.ts` filters on THIS constant
// rather than a literal, for the reason `WORK_EVIDENCE_WAIVER_KIND` carries: a kind renamed here and
// not there is a filter that quietly matches nothing and offers every blocked row again.
// cm:edge lockstep -> packages/core/src/devices/admissible.ts — that query must filter on this constant and never a literal
export const DISPATCH_GATING_KIND: IssueDependencyKind = 'blocks';

// cm:guard the ONE list in core of the statuses at which a blocker stops holding its dependent
// back, and it is a MIRROR rather than an authorship. The writer of that lane is the contract the
// master runs on, whose ORDER ends `developed, testing, awaiting_release, closed`, and
// forge-plugin's `holdsBack` (src/flow/earned.mjs) lets a blocker through only at or past
// `developed` on it. Core's job is to agree, and the two directions cost differently. REMOVING a
// status the contract does call settled is the dangerous edit: `b.status NOT IN (...)` then matches
// more blockers, core hides more, and it hides a row the master would take — work nobody ever sees.
// ADDING one the contract does not call settled offers a row the master refuses, which costs a
// master pass and is visible in the count. Neither is free; only the first is silent
// (`devices/admissible.ts:readAdmissibleIssues` states the subset rule in full).
// cm:edge lockstep -> packages/core/src/devices/admissible.ts — its only reader; a second reader owes this list another look, never a copy
export const BLOCKER_SETTLED_STATUSES: readonly IssueStatus[] = [
  'developed',
  'testing',
  'awaiting_release',
  'closed',
];

// cm:guard this note says what core ENFORCES and nothing else. It read "B waits for A's `merged_at`
// stamp before it may dispatch" from ISS-935 until ISS-1100, and by then no query in core gated any
// dispatch decision on a `blocks` edge at all — `dependency-read.ts:digest` records that
// `gatesDispatch` was deleted from the edge digest when the gate it named went. So core published a
// merge-based rule it enforced nowhere while the master applied a status-based one, and the two
// surfaces a reader compares said different things. The status rule is the one that runs.
const GATES_DISPATCH_NOTE =
  'B is held out of the admissible set a master reads while a live `blocks` edge points at it ' +
  `from an A that has not reached \`${BLOCKER_SETTLED_STATUSES[0]}\` — the statuses that release ` +
  `it are ${BLOCKER_SETTLED_STATUSES.map((s) => `\`${s}\``).join(', ')}. A reopened A blocks ` +
  'again. Retracting the edge (`validUntil` in the past) stops it holding B here, and dropping A ' +
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
