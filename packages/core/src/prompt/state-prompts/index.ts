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
