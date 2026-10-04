import {
  failureKindEnum,
  type PipelineControl,
  type PipelineHealth,
  type RecoveryStats,
  recoveryStatsSchema,
} from '@forge/contracts/pipeline-control';
import { z } from 'zod';

// Input schema for the POST endpoint — admin sends a partial; the route fills
// in audit fields (pausedBy, pausedAt, updatedAt) server-side.
export const pipelineControlInputSchema = z
  .object({
    paused: z.boolean().optional(),
    abort: z.boolean().optional(),
    reason: z.string().max(2000).nullable().optional(),
  })
  .strict()
  .refine((o) => Object.keys(o).length > 0, { message: 'no control fields' });

type PipelineControlInput = z.infer<typeof pipelineControlInputSchema>;

export const DEFAULT_RECOVERY_STATS: RecoveryStats = {
  totalFailures: 0,
  byKind: { code: 0, infra: 0, 'transient-cc': 0, timeout: 0 },
  lastFailureAt: new Date(0).toISOString(),
  lastFailureKind: 'infra',
  autoRetries: 0,
};

export const pipelineHealthInputSchema = z
  .object({
    retryCount: z.number().int().min(0).optional(),
    recoveryStats: recoveryStatsSchema.optional(),
    lastError: z
      .object({
        message: z.string().max(4000),
        ts: z.iso.datetime(),
        jobId: z.string().uuid().nullable(),
      })
      .nullable()
      .optional(),
  })
  .strict()
  .refine((o) => Object.keys(o).length > 0, { message: 'no health fields' });

type PipelineHealthInput = z.infer<typeof pipelineHealthInputSchema>;

export const DEFAULT_PIPELINE_HEALTH: PipelineHealth = {
  retryCount: 0,
  recoveryStats: DEFAULT_RECOVERY_STATS,
  lastError: null,
  updatedAt: new Date(0).toISOString(),
};

export function buildPipelineControl(
  prev: Partial<PipelineControl> | null,
  input: PipelineControlInput,
  actorId: string,
): PipelineControl {
  const now = new Date().toISOString();
  const wasPaused = prev?.paused === true;
  const willPause = input.paused === true;
  // Pre-Epic-3 rows used `note` instead of `reason`; carry it forward on first
  // read so legacy data isn't silently dropped.
  const legacyNote = (prev as { note?: string | null } | null | undefined)?.note;
  const inheritedReason = prev?.reason ?? (typeof legacyNote === 'string' ? legacyNote : null);
  return {
    paused: input.paused ?? prev?.paused ?? false,
    pausedBy: willPause
      ? actorId
      : wasPaused && input.paused === false
        ? null
        : (prev?.pausedBy ?? null),
    pausedAt:
      willPause && !wasPaused ? now : input.paused === false ? null : (prev?.pausedAt ?? null),
    // Reason describes the active pause — clear it on resume so a stale
    // "manual" note doesn't survive the next pause cycle.
    reason:
      input.reason !== undefined ? input.reason : input.paused === false ? null : inheritedReason,
    abort: input.abort ?? prev?.abort ?? false,
    updatedAt: now,
  };
}

// Normalise a legacy or partial pipeline_control row into the canonical shape.
// Returns null when nothing has been written yet.
export function normalisePipelineControl(raw: unknown): PipelineControl | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const legacyNote = typeof r.note === 'string' ? r.note : null;
  return {
    paused: r.paused === true,
    pausedBy: typeof r.pausedBy === 'string' ? r.pausedBy : null,
    pausedAt: typeof r.pausedAt === 'string' ? r.pausedAt : null,
    reason: typeof r.reason === 'string' ? r.reason : legacyNote,
    abort: r.abort === true,
    updatedAt: typeof r.updatedAt === 'string' ? r.updatedAt : new Date(0).toISOString(),
  };
}

export function buildPipelineHealth(
  prev: Partial<PipelineHealth> | null,
  input: PipelineHealthInput,
): PipelineHealth {
  return {
    retryCount: input.retryCount ?? prev?.retryCount ?? 0,
    recoveryStats: input.recoveryStats ?? prev?.recoveryStats ?? DEFAULT_RECOVERY_STATS,
    lastError: input.lastError !== undefined ? input.lastError : (prev?.lastError ?? null),
    updatedAt: new Date().toISOString(),
  };
}

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
