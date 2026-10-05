import { failureKindEnum, type RecoveryStats } from '@forge/contracts/pipeline-control';
export const DEFAULT_RECOVERY_STATS: RecoveryStats = {
  totalFailures: 0,
  byKind: { code: 0, infra: 0, 'transient-cc': 0, timeout: 0 },
  lastFailureAt: new Date(0).toISOString(),
  lastFailureKind: 'infra',
  autoRetries: 0,
};
/**
 * Coerce a legacy or partial `recoveryStats` blob into the canonical
 * structured shape. Pre-ISS-197 rows wrote a free-form
 * `Record<string, number>`; those values are dropped (they were never
 * meaningful) and replaced with DEFAULT_RECOVERY_STATS so the next failure
 * starts a clean counter.
 */
export function normaliseRecoveryStats(raw: unknown): RecoveryStats {
  if (!raw || typeof raw !== 'object') return { ...DEFAULT_RECOVERY_STATS };
  const r = raw as Record<string, unknown>;
  const byKindRaw = (r.byKind ?? {}) as Record<string, unknown>;
  const num = (v: unknown): number =>
    typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.floor(v) : 0;
  const lastKind = r.lastFailureKind;
  const lastFailureKind = failureKindEnum.safeParse(lastKind).success
    ? (lastKind as RecoveryStats['lastFailureKind'])
    : 'infra';
  const lastAt = typeof r.lastFailureAt === 'string' ? r.lastFailureAt : new Date(0).toISOString();
  return {
    totalFailures: num(r.totalFailures),
    byKind: {
      code: num(byKindRaw.code),
      infra: num(byKindRaw.infra),
      'transient-cc': num(byKindRaw['transient-cc']),
      timeout: num(byKindRaw.timeout),
    },
    lastFailureAt: lastAt,
    lastFailureKind,
    autoRetries: num(r.autoRetries),
  };
}
