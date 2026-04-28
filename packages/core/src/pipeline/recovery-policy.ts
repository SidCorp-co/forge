/**
 * Recovery policy for the pipeline self-healing sweeper (Phase H, ISS-306).
 *
 * Decides what the sweeper should do when it finds an issue stuck in a
 * pipeline status with no active job and a terminal latest job. The
 * policy is per-project (read off `projects.agentConfig.pipelineConfig`)
 * with sensible defaults that work out-of-the-box.
 *
 * Three input axes:
 *   • failureKind     — transient | permanent | unknown (from classifier)
 *   • recovery budget — caps differ per kind (transient: forgiving,
 *     permanent: zero, unknown: cautious)
 *   • recovery window — sliding 24h. Once it elapses, attempts auto-reset
 *     so a one-off bad day doesn't permanently strand an issue.
 */

import type { FailureKind } from './failure-classifier.js';

export interface RecoveryConfig {
  /** Max recoveries per window when no per-kind override is set. Default 3. */
  maxAttempts: number;
  /** Window in hours; attempts auto-reset once exceeded. Default 24. */
  windowHours: number;
  /** Per-kind cap. transient is generous, permanent is zero. */
  byKind: Partial<Record<FailureKind, number>>;
}

export const DEFAULT_RECOVERY_CONFIG: RecoveryConfig = {
  maxAttempts: 3,
  windowHours: 24,
  byKind: {
    transient: 5,
    unknown: 2,
    permanent: 0,
  },
};

export type RecoveryDecision =
  | { decide: 'recover'; nextAttempt: number; resetWindow: boolean }
  | { decide: 'escalate'; reason: string }
  | { decide: 'skip'; reason: string };

export interface IssueRecoveryState {
  recoveryAttempts: number;
  lastRecoveryAt: Date | null;
  recoveryWindowStartedAt: Date | null;
}

export interface RecoveryInput {
  issue: IssueRecoveryState;
  failureKind: FailureKind | null;
  /** Project pipelineConfig — undefined falls back to defaults. */
  config?: Partial<RecoveryConfig> | null;
  /** Used in tests; defaults to Date.now() at call site. */
  now?: Date;
}

/**
 * Pure function: given an issue's recovery state and its latest job's
 * failure kind, return what the sweeper should do next.
 *
 * Rules:
 *  1. Permanent failure → escalate immediately, regardless of attempts.
 *  2. Window elapsed → treat as "fresh start" (resetWindow=true).
 *  3. Attempts >= cap → escalate.
 *  4. Otherwise → recover with attempts+1.
 *
 * Caller is responsible for the SQL update (resetting attempts when
 * resetWindow=true, bumping recovery_attempts otherwise).
 */
export function decideRecovery(input: RecoveryInput): RecoveryDecision {
  if (input.failureKind === null) {
    return { decide: 'skip', reason: 'no failure kind on latest job (likely cancelled or done)' };
  }

  const cfg = mergeConfig(input.config ?? null);
  const cap = capForKind(cfg, input.failureKind);

  // Permanent failures bypass the budget — there is no point retrying a
  // deterministic block (content filter, auth). Escalate as soon as we
  // see one, even if the issue had headroom in its budget.
  if (input.failureKind === 'permanent' || cap === 0) {
    return {
      decide: 'escalate',
      reason: `permanent failure (${input.failureKind})`,
    };
  }

  const now = input.now ?? new Date();
  const windowExpired = isWindowExpired(input.issue, cfg, now);

  if (windowExpired) {
    // Fresh start — give one recovery and re-anchor the window.
    return { decide: 'recover', nextAttempt: 1, resetWindow: true };
  }

  if (input.issue.recoveryAttempts >= cap) {
    return {
      decide: 'escalate',
      reason: `recovery budget exhausted (${input.issue.recoveryAttempts}/${cap} ${input.failureKind})`,
    };
  }

  return {
    decide: 'recover',
    nextAttempt: input.issue.recoveryAttempts + 1,
    resetWindow: false,
  };
}

function mergeConfig(partial: Partial<RecoveryConfig> | null): RecoveryConfig {
  if (!partial) return DEFAULT_RECOVERY_CONFIG;
  return {
    maxAttempts: partial.maxAttempts ?? DEFAULT_RECOVERY_CONFIG.maxAttempts,
    windowHours: partial.windowHours ?? DEFAULT_RECOVERY_CONFIG.windowHours,
    byKind: { ...DEFAULT_RECOVERY_CONFIG.byKind, ...(partial.byKind ?? {}) },
  };
}

function capForKind(cfg: RecoveryConfig, kind: FailureKind): number {
  const v = cfg.byKind[kind];
  return typeof v === 'number' ? v : cfg.maxAttempts;
}

function isWindowExpired(state: IssueRecoveryState, cfg: RecoveryConfig, now: Date): boolean {
  // Never had a recovery yet → not "expired"; first recovery starts the window.
  if (!state.recoveryWindowStartedAt) return false;
  const elapsedMs = now.getTime() - state.recoveryWindowStartedAt.getTime();
  return elapsedMs > cfg.windowHours * 3_600_000;
}
