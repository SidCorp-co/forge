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

import type { IssueDependencyKind } from '../db/schema.js';

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

const GATES_DISPATCH_NOTE =
  "B waits for A's `merged_at` stamp before it may dispatch. A reopened A blocks again, and a " +
  'closed A without that stamp unblocks B only on a structurally unstampable base.';

export type DependencyKindEffect = {
  gatesDispatch: boolean;
  waivesWorkEvidence: boolean;
  note: string;
};

/** What wiring an edge of this kind will actually do, for the caller that just wired it. */
export function describeDependencyKind(kind: IssueDependencyKind): DependencyKindEffect {
  if (kind === 'blocks') {
    return { gatesDispatch: true, waivesWorkEvidence: false, note: GATES_DISPATCH_NOTE };
  }
  if (kind === WORK_EVIDENCE_WAIVER_KIND) {
    return { gatesDispatch: false, waivesWorkEvidence: true, note: WORK_EVIDENCE_WAIVER_NOTE };
  }
  return { gatesDispatch: false, waivesWorkEvidence: false, note: NO_EFFECT_NOTE };
}
