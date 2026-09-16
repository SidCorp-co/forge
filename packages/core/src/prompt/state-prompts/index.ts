/**
 * Built-in, per-state default system-prompt blocks (one file per state).
 *
 * Layered AFTER the shared preamble (Pipeline Rules / Tool Reference / Project
 * Config / Project Context) and BEFORE any project `states[state].systemPrompt`
 * override — see `prompt/system.ts`. Keyed by `JobType` (the step that runs at
 * each auto-dispatch state).
 *
 * Each block is platform-level POLICY for its state (objective + what to
 * emphasize + the exit/status contract) — short and stable. The detailed
 * procedure lives in the per-state skill.
 */
import type { JobType } from '../../db/schema.js';
import { releaseBatchStatePrompt } from './release-batch.js';

export const DEFAULT_STATE_SYSTEM_PROMPTS: Partial<Record<JobType, string>> = {
  release_batch: releaseBatchStatePrompt,
};

/** Resolve the built-in state block for a step, or null when none applies. */
export function getStatePrompt(step: JobType | null | undefined): string | null {
  if (!step) return null;
  return DEFAULT_STATE_SYSTEM_PROMPTS[step] ?? null;
}
