/**
 * Pipeline configuration: skill mapping, step resolution, trigger logic.
 */

import type { PipelineConfig, PipelineStepConfig, PipelineCondition } from '../pipeline-antigravity';

// ─── Skill Mapping ───────────────────────────────────────────────────────────

// Status → skill mapping. Only statuses that trigger an agent step are listed.
export const PIPELINE_SKILLS: Record<string, { skill: string; prompt: (issue: any) => string }> = {
  open: {
    skill: 'forge-triage',
    prompt: (issue) => `/forge-triage ${issue.documentId}`,
  },
  confirmed: {
    skill: 'forge-clarify',
    prompt: (issue) => `/forge-clarify ${issue.documentId}`,
  },
  clarified: {
    skill: 'forge-plan',
    prompt: (issue) => `/forge-plan ${issue.documentId}`,
  },
  approved: {
    skill: 'forge-code',
    prompt: (issue) => `/forge-code ${issue.documentId}`,
  },
  developed: {
    skill: 'forge-review',
    prompt: (issue) => `/forge-review ${issue.documentId}`,
  },
  testing: {
    skill: 'forge-test',
    prompt: (issue) => `/forge-test ${issue.documentId}`,
  },
  reopen: {
    skill: 'forge-fix',
    prompt: (issue) => `/forge-fix ${issue.documentId}`,
  },
  released: {
    skill: 'forge-release',
    prompt: (issue) => `/forge-release ${issue.documentId}`,
  },
};

// Statuses that should only trigger when the transition comes from a specific source.
const TRIGGER_GUARDS: Record<string, { excludeFrom: string[] }> = {
  open: { excludeFrom: ['needs_info'] },
};

/** Minimum seconds between pipeline triggers for the same issue+status. */
export const DEDUP_WINDOW_MS = 2 * 60 * 1000; // 2 minutes

export const STEP_TOGGLES: Record<string, keyof PipelineConfig> = {
  open: 'autoTriage',
  confirmed: 'autoClarify',
  clarified: 'autoPlan',
  approved: 'autoCode',
  developed: 'autoReview',
  testing: 'autoTest',
  reopen: 'autoFix',
  released: 'autoRelease',
};

// ─── Custom Step Resolution ─────────────────────────────────────────────────

export interface ResolvedStep {
  skill: string;
  prompt: (issue: any) => string;
  runner?: 'desktop' | 'antigravity';
  model?: string;
  skip?: PipelineCondition;
  nextStatus?: string;
}

/**
 * Evaluate whether a pipeline step should be skipped for this issue.
 * Returns true if the skip condition matches the issue's field value.
 */
export function shouldSkipStep(issue: any, skip: PipelineCondition): boolean {
  const val = issue[skip.field];
  switch (skip.op) {
    case 'eq':    return val === skip.value;
    case 'neq':   return val !== skip.value;
    case 'in':    return Array.isArray(skip.value) && skip.value.includes(val);
    case 'notIn': return Array.isArray(skip.value) && !skip.value.includes(val);
    default:      return false;
  }
}

/**
 * Resolve the pipeline step for a given status.
 * Checks pipelineSteps first, falls back to PIPELINE_SKILLS.
 */
export function resolveStepForStatus(pipelineConfig: PipelineConfig, status: string): ResolvedStep | null {
  const customSteps = pipelineConfig.pipelineSteps;
  if (customSteps && customSteps.length > 0) {
    const step = customSteps.find((s) => s.status === status);
    if (step) {
      return {
        skill: step.skill,
        prompt: (issue: any) => `/${step.skill} ${issue.documentId}`,
        runner: step.runner,
        model: step.model,
        skip: step.skip,
        nextStatus: step.nextStatus,
      };
    }
  }

  const defaultSkill = PIPELINE_SKILLS[status];
  if (!defaultSkill) return null;

  // Backward compatibility: Simple issues skip clarify when using default PIPELINE_SKILLS
  if (status === 'confirmed') {
    return {
      ...defaultSkill,
      skip: { field: 'complexity', op: 'eq', value: 'Simple' },
      nextStatus: 'clarified',
    };
  }

  return defaultSkill;
}

/** Normalize step config — supports both boolean and object form. */
export function resolveStepConfig(value: boolean | PipelineStepConfig | undefined): {
  enabled: boolean;
  runner: 'desktop' | 'antigravity';
  model?: string;
} {
  if (value === undefined || value === false) return { enabled: false, runner: 'desktop' };
  if (value === true) return { enabled: true, runner: 'desktop' };
  return {
    enabled: value.enabled !== false,
    runner: value.runner || 'desktop',
    model: value.model,
  };
}

/**
 * Check if a pipeline step should trigger for this status transition.
 */
export function shouldTrigger(
  newStatus: string,
  fromStatus: string,
  pipelineConfig: PipelineConfig,
  manual = false,
): boolean {
  if (!manual && !pipelineConfig.enabled) return false;

  const hasDefaultSkill = !!PIPELINE_SKILLS[newStatus];
  const hasCustomStep = !!pipelineConfig.pipelineSteps?.some((s) => s.status === newStatus);
  if (!hasDefaultSkill && !hasCustomStep) return false;

  // Per-step toggle gate — only applies to automatic triggers.
  // Manual triggers (UI button, MCP tool) bypass toggle checks so users can
  // run any step on demand even when the auto-* toggle is off.
  if (!manual) {
    const toggleKey = STEP_TOGGLES[newStatus];
    if (toggleKey) {
      const stepVal = pipelineConfig[toggleKey];
      const step = resolveStepConfig(stepVal as any);
      if (!step.enabled) return false;
    }
  }

  const guard = TRIGGER_GUARDS[newStatus];
  if (guard?.excludeFrom.includes(fromStatus)) return false;

  return true;
}
