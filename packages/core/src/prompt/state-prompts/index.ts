/**
 * Built-in, per-state default system-prompt blocks (one file per state).
 *
 * Layered AFTER the shared preamble (Pipeline Rules / Tool Reference / Project
 * Config / Project Context) and BEFORE any project `states[state].systemPrompt`
 * override — see `prompt/system.ts`. Keyed by `JobType` (the step that runs at
 * each auto-dispatch state). Intermediate states with no step (deploying /
 * tested / staging) and non-pipeline steps (custom / pm) have no default block.
 *
 * Each block is platform-level POLICY for its state (objective + what to
 * emphasize + the exit/status contract) — short and stable. The detailed
 * procedure lives in the per-state skill. Improve one state by editing its file
 * without touching the others; projects can still override per state on top.
 */
import type { JobType } from '../../db/schema.js';
import { clarifyStatePrompt } from './clarify.js';
import { codeStatePrompt } from './code.js';
import { fixStatePrompt } from './fix.js';
import { planStatePrompt } from './plan.js';
import { releaseStatePrompt } from './release.js';
import { reviewStatePrompt } from './review.js';
import { testStatePrompt } from './test.js';
import { triageStatePrompt } from './triage.js';

export const DEFAULT_STATE_SYSTEM_PROMPTS: Partial<Record<JobType, string>> = {
  triage: triageStatePrompt,
  clarify: clarifyStatePrompt,
  plan: planStatePrompt,
  code: codeStatePrompt,
  review: reviewStatePrompt,
  test: testStatePrompt,
  fix: fixStatePrompt,
  release: releaseStatePrompt,
};

/** Resolve the built-in state block for a step, or null when none applies. */
export function getStatePrompt(step: JobType | null | undefined): string | null {
  if (!step) return null;
  return DEFAULT_STATE_SYSTEM_PROMPTS[step] ?? null;
}
