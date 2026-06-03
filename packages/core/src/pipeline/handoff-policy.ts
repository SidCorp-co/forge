import type { JobType } from '../db/schema.js';
import { type HandoffStep, isHandoffStep } from '../memory/step-handoff-schema.js';
import type { UserPromptPolicyConfig } from './pipeline-config-schema.js';

/**
 * Resolved step-handoff policy with defaults applied.
 *
 * Step-handoff is **default-on system-wide** as of 2026-05-29: projects do
 * NOT need to opt in via `agentConfig.pipelineConfig.states.<state>.userPromptPolicy.handoffs`.
 * Explicit config still wins per-field — a project that sets only
 * `enabled: false` gets the rest of the defaults, etc.
 *
 * The default `injectFromSteps` follows the canonical pipeline order so each
 * downstream state automatically receives every prior step's handoff:
 *
 *   triage  → []                             (root — no prior)
 *   clarify → [triage]
 *   plan    → [triage, clarify]              (repro evidence + root-cause hypothesis)
 *   code    → [triage, plan]
 *   review  → [triage, plan, code]
 *   test    → [triage, plan, code]           (review verdict drives test scope)
 *   fix     → [triage, plan, code, review]
 *
 * clarify's findings flow to plan only — plan distills them into its own
 * handoff, so code/review/test stay lean.
 */
export interface ResolvedHandoffsPolicy {
  enabled: boolean;
  injectFromSteps: HandoffStep[];
  requireHandoffWrite: boolean;
  missingMarkerPolicy: 'fail' | 'warn' | 'silent';
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
};

function defaultInjectFromSteps(jobType: JobType): HandoffStep[] {
  if (!isHandoffStep(jobType)) return [];
  return DEFAULT_INJECT_BY_STEP[jobType];
}

/**
 * Merge an explicit `userPromptPolicy.handoffs` config (may be undefined) with
 * the system defaults. Used by:
 *   - `handoff-prefetch.ts` (dispatcher / orchestrator pre-fetch)
 *   - `prompt/user.ts`     (prompt builder injection + termination block)
 *
 * Keeping the resolution centralised guarantees the call sites agree on
 * what "default-on" means even when a project supplies a partial config.
 */
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
    requireHandoffWrite: explicit?.requireHandoffWrite ?? true,
    missingMarkerPolicy: explicit?.missingMarkerPolicy ?? 'warn',
    fallbackToRawIssueFieldIfMissing: explicit?.fallbackToRawIssueFieldIfMissing ?? true,
  };
}
