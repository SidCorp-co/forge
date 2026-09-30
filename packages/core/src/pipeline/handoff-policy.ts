import type { JobType } from '../db/schema.js';
import { type HandoffStep, isHandoffStep } from '../memory/step-handoff-schema.js';

const INJECT_BY_STEP: Record<HandoffStep, HandoffStep[]> = {
  triage: [],
  clarify: ['triage'],
  plan: ['triage', 'clarify'],
  code: ['triage', 'plan'],
  review: ['triage', 'plan', 'code'],
  test: ['triage', 'plan', 'code'],
  fix: ['triage', 'plan', 'code', 'review'],
  drive: [],
};

/** The prior steps whose handoffs a job of this type is shown. */
export function handoffInjectSteps(jobType: JobType): HandoffStep[] {
  if (!isHandoffStep(jobType)) return [];
  return INJECT_BY_STEP[jobType];
}
