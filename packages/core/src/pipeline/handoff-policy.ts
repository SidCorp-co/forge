import { type HandoffStep, isHandoffStep } from '../memory/step-handoff-schema.js';
import type { UserPromptPolicyConfig } from './pipeline-config-schema.js';

export interface ResolvedHandoffsPolicy {
  enabled: boolean;
  injectFromSteps: HandoffStep[];
  fallbackToRawIssueFieldIfMissing: boolean;
}

/** No live job type inherits a prior step's handoff by default, so only an explicit list injects. */
export function resolveHandoffsPolicy(
  policy: UserPromptPolicyConfig | null | undefined,
): ResolvedHandoffsPolicy {
  const explicit = policy?.handoffs;
  // The config schema accepts non-emitting steps such as `release`; only handoff steps survive.
  const explicitInject = explicit?.injectFromSteps?.filter((s): s is HandoffStep =>
    isHandoffStep(s),
  );
  return {
    enabled: explicit?.enabled ?? true,
    injectFromSteps: explicitInject ?? [],
    fallbackToRawIssueFieldIfMissing: explicit?.fallbackToRawIssueFieldIfMissing ?? true,
  };
}
