// Park semantics: the statuses an issue rests at when the pipeline cannot
// proceed, and the one rule for leaving them.
//
// This module exists because that rule was previously restated in five places
// — two hard-coded literals in the orchestrator's transition hook, the
// `pipeline-rules` prompt block, two guides, and the status-pipeline doc — with
// no shared constant, so they drifted. The two TypeScript copies now read
// PARK_EXIT_RULE from here and a test pins them; the markdown copies point at
// the guide instead of restating it.
//
// The asymmetry worth knowing before you edit: entering a park is free from
// anywhere, leaving one is not. `needs_info` is a bounce state
// (bounce-replay-guard.ts) but NOT a park — its release rule is a human comment
// (ISS-820), which is stricter and separately enforced.

import type { IssueStatus } from '../db/schema.js';

// cm:edge lockstep -> packages/core/src/pipeline/orchestrator.ts — the transition hook's exit guards read this set; adding a status here changes dispatch behaviour
// cm:edge lockstep -> packages/core/src/pipeline/bounce-replay-guard.ts — BOUNCE_STATUSES derives from this set, so a park added here joins the replay guard automatically
// cm:guard a status belongs here ONLY if the orchestrator skips enqueue when a non-user actor leaves it — this set is the definition of "parked", not a list of human-gated states (`tested` is human-gated but NOT parked: leaving it dispatches normally)
export const PARKED_STATUSES = ['waiting', 'on_hold'] as const satisfies readonly IssueStatus[];

export type ParkedStatus = (typeof PARKED_STATUSES)[number];

// cm:edge contract -> packages/contracts/src/rows.ts — the park CAUSE vocabulary (`WaitingCause`) lives there and is DERIVED by classifyWaitingCause, never stored; do not add a second enumeration of park reasons here

export function isParkedStatus(status: string): status is ParkedStatus {
  return (PARKED_STATUSES as readonly string[]).includes(status);
}

// cm:edge lockstep -> packages/core/src/guides/registry.ts — the pipeline-and-issue-lifecycle guide embeds this string verbatim
// cm:edge lockstep -> packages/core/src/prompt/facts/registry.ts — the pipeline-rules block embeds this string verbatim
// cm:guard one sentence, present tense, no markdown — it is inlined into a prompt and a guide; a drift test asserts both carry it byte-for-byte
export const PARK_EXIT_RULE =
  'Leaving `waiting` or `on_hold` re-engages the pipeline ONLY when the actor is a human user or the transition carries reason `operator_unblock`; an agent that sets a forward status from either one changes the status and dispatches NOTHING.';

export const LIFECYCLE_GUIDE_POINTER = 'forge_guide get pipeline-and-issue-lifecycle';
