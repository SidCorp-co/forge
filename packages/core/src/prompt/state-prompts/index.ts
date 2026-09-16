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

// cm:guard ONE entry, and the five claimable job types are the whole of what may ever have one: `RUNNER_CAPABILITIES` (pipeline/registry.ts) admits `drive`, `smoke`, `release_batch`, `reconcile` and `verify_skill`, and a job of any other type is refused `runner_unsupported_type` before a prompt is built. Eight entries keyed on the staged types survived the ISS-895 lane removal here and rendered for nobody until ISS-1047; a new entry that is not one of those five is a block no job can receive.
// cm:why `drive` has no entry on purpose — the driver's per-state depth is the `issue-flow` skill in github.com/SidCorp-co/forge-plugin, not a block core writes, and `mandatoryPreambleBlocks` is where its lane fork lives.
// cm:why release_batch is issue-less — the agent never calls forge_step_start; its entry point is GET /api/projects/:projectId/release-batches/:runId
export const DEFAULT_STATE_SYSTEM_PROMPTS: Partial<Record<JobType, string>> = {
  release_batch: releaseBatchStatePrompt,
};

/** Resolve the built-in state block for a step, or null when none applies. */
export function getStatePrompt(step: JobType | null | undefined): string | null {
  if (!step) return null;
  return DEFAULT_STATE_SYSTEM_PROMPTS[step] ?? null;
}
