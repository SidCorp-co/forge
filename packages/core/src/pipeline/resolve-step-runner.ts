import type { JobType, RunnerType } from '../db/schema.js';
import { STATUS_TO_JOB_TYPE } from './skill-mapping.js';

/**
 * Resolve the runner fallback chain for a specific job at dispatch time.
 *
 * ISS-232 Phase 3 — the project-level `runnerFallback` chain was removed.
 * The v2 selector picks primary → standby deterministically; runner-type
 * matching is enforced post-select via `runnerSupportsJobType`. The
 * per-step `runner` override on a step toggle still wins when set, but it is
 * a single-element chain — there is no project-wide cascade behind it.
 *
 * Pure function — no DB reads. Caller (dispatcher) supplies the
 * `agentConfig` jsonb it already loaded.
 */
export function resolveRunnerChainForJob(
  jobType: JobType,
  agentConfig: Record<string, unknown> | null | undefined,
): RunnerType[] {
  const cfg = (agentConfig ?? {}) as {
    pipelineConfig?: Record<string, unknown>;
  };

  const pipelineCfg = (cfg.pipelineConfig ?? {}) as Record<string, unknown>;
  const toggleKey = findToggleKeyForJobType(jobType);
  if (!toggleKey) return ['claude-code'];

  const toggle = pipelineCfg[toggleKey];
  const perStepRunner = extractRunnerFromToggle(toggle);
  return perStepRunner ? [perStepRunner] : ['claude-code'];
}

function findToggleKeyForJobType(jobType: JobType): string | null {
  for (const skill of Object.values(STATUS_TO_JOB_TYPE)) {
    if (skill?.type === jobType) return skill.toggle;
  }
  return null;
}

function extractRunnerFromToggle(toggle: unknown): RunnerType | null {
  if (!toggle || typeof toggle !== 'object' || Array.isArray(toggle)) return null;
  const runner = (toggle as { runner?: unknown }).runner;
  if (typeof runner !== 'string') return null;
  return isKnownRunnerType(runner) ? runner : null;
}

// cm:guard the "a known override wins over the default" arm is UNTESTABLE while this set holds one member — the override and the default are the same string, so any such test passes vacuously. Two were deleted rather than kept green when `antigravity` went (2026-09-04). Restore them in the same commit that adds the second type; only the unknown-type rejection is covered until then.
const KNOWN_RUNNER_TYPES: ReadonlySet<RunnerType> = new Set(['claude-code']);

function isKnownRunnerType(v: unknown): v is RunnerType {
  return typeof v === 'string' && KNOWN_RUNNER_TYPES.has(v as RunnerType);
}
