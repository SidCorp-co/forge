import type { JobType, RunnerType } from '../db/schema.js';
import { STATUS_TO_JOB_TYPE } from './skill-mapping.js';

/**
 * Resolve the runner fallback chain for a specific job at dispatch time.
 *
 * Priority:
 *   1. Per-step runner from `pipelineConfig.<toggle>.runner` (object form
 *      only — boolean toggles imply "use project default").
 *   2. Project-level `agentConfig.runnerFallback`.
 *   3. Hardcoded `['claude-code']` default.
 *
 * The per-step runner is prepended to the project chain rather than
 * replacing it: this lets a project default to claude-code, override one
 * step to antigravity, and still fall back to claude-code if the
 * antigravity adapter is offline. Duplicate types are de-duplicated so the
 * dispatcher doesn't try the same type twice.
 *
 * Pure function — no DB reads. Caller (dispatcher) supplies the
 * `agentConfig` jsonb it already loaded.
 */
export function resolveRunnerChainForJob(
  jobType: JobType,
  agentConfig: Record<string, unknown> | null | undefined,
): RunnerType[] {
  const cfg = (agentConfig ?? {}) as {
    runnerFallback?: unknown;
    pipelineConfig?: Record<string, unknown>;
  };

  const projectChain = normalizeChain(cfg.runnerFallback);
  const pipelineCfg = (cfg.pipelineConfig ?? {}) as Record<string, unknown>;

  const toggleKey = findToggleKeyForJobType(jobType);
  if (!toggleKey) return projectChain;

  const toggle = pipelineCfg[toggleKey];
  const perStepRunner = extractRunnerFromToggle(toggle);
  if (!perStepRunner) return projectChain;

  // De-dupe: prepend per-step, then project chain minus per-step.
  return [perStepRunner, ...projectChain.filter((r) => r !== perStepRunner)];
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

function normalizeChain(value: unknown): RunnerType[] {
  if (!Array.isArray(value)) return ['claude-code'];
  const filtered = value.filter(isKnownRunnerType);
  return filtered.length > 0 ? filtered : ['claude-code'];
}

const KNOWN_RUNNER_TYPES: ReadonlySet<RunnerType> = new Set(['claude-code', 'antigravity']);

function isKnownRunnerType(v: unknown): v is RunnerType {
  return typeof v === 'string' && KNOWN_RUNNER_TYPES.has(v as RunnerType);
}
