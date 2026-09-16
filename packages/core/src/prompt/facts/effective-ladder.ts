/**
 * ISS-1066 — what a project's pipeline states ARE, as one function two readers answer from.
 *
 * The stored `pipelineConfig.states` map is per-stage CONFIGURATION over four optional keys, not a
 * sequence: nearly every project stores only `open`, and reading its keys as the project's pipeline
 * is how the benchmark asked `forge-plugin` for a one-state pipeline on 2026-09-17 and would have
 * graded the right answer wrong. The sequence is `CANONICAL_LADDER`; the only override a project
 * has over it is switching a stage off.
 */

import type { IssueStatus } from '../../db/schema.js';
import { CANONICAL_LADDER } from './registry.js';

/** The one key of a stage's config this rule reads; the stage schema carries more and none of it is a sequence. */
export interface LadderStageConfig {
  enabled?: boolean;
}

// cm:guard RENDERING, exactly as `buildLadder` is: a status left out here is one a reader is not
// shown, never one the pipeline routes around. Nothing skips at runtime, and reading this filter as
// a routing decision is how `enabled` came to be described as an auto-transition it never performed
// (ISS-994).
// cm:edge lockstep -> packages/core/src/prompt/facts/resolve.ts — `buildLadder` is the same filter
// over the same array, and it is a second copy only because ISS-1048 (PR #457) holds that file: a
// file another run holds is not ISS-1066's to edit. `effective-ladder.test.ts` reads that file's
// text and goes red the moment the two stop matching, and the collapse into this function is ISS-1048's
// to make. Do not add a third copy.
/**
 * The project's effective pipeline states, in order: the canonical ladder minus every stage the
 * project switched off. An absent or empty `states` map is every rung, never none.
 */
export function effectivePipelineStates(
  states: Record<string, LadderStageConfig | undefined> | null | undefined,
): IssueStatus[] {
  const configured = states ?? {};
  return CANONICAL_LADDER.filter((stage) => configured[stage]?.enabled !== false);
}
