import type { JobType } from '../db/schema.js';
import { type HandoffStep, isHandoffStep } from '../memory/step-handoff-schema.js';
import type { UserPromptPolicyConfig } from './pipeline-config-schema.js';

export interface ResolvedHandoffsPolicy {
  enabled: boolean;
  injectFromSteps: HandoffStep[];
  fallbackToRawIssueFieldIfMissing: boolean;
}

const DEFAULT_INJECT_BY_STEP: Record<HandoffStep, HandoffStep[]> = {
  triage: [],
  clarify: ['triage'],
  plan: ['triage', 'clarify'],
  code: ['triage', 'plan'],
  review: ['triage', 'plan', 'code'],
  test: ['triage', 'plan', 'code'],
  fix: ['triage', 'plan', 'code', 'review'],
  drive: [],
};

function defaultInjectFromSteps(jobType: JobType): HandoffStep[] {
  if (!isHandoffStep(jobType)) return [];
  return DEFAULT_INJECT_BY_STEP[jobType];
}

export function resolveHandoffsPolicy(
  policy: UserPromptPolicyConfig | null | undefined,
  jobType: JobType,
): ResolvedHandoffsPolicy {
  const explicit = policy?.handoffs;
  // Narrow explicit `injectFromSteps` (Zod accepts any pipeline step incl.
  // non-emitting ones like `release`) down to actual handoff steps so
  // downstream code never has to re-check.
  const explicitInject = explicit?.injectFromSteps?.filter((s): s is HandoffStep =>
    isHandoffStep(s as JobType),
  );
  return {
    enabled: explicit?.enabled ?? true,
    injectFromSteps: explicitInject ?? defaultInjectFromSteps(jobType),
    fallbackToRawIssueFieldIfMissing: explicit?.fallbackToRawIssueFieldIfMissing ?? true,
  };
}
