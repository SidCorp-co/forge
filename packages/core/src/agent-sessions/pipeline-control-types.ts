import { z } from 'zod';

// Typed shape for the agent_sessions.pipeline_control jsonb column. Pre-Epic-3
// rows wrote a free-form jsonb merge; this schema normalises the contract so
// downstream consumers (admin dashboard, runners) can rely on field names.
// Legacy rows tolerate `pipelineControlSchema.partial().parse()` on read.
export const pipelineControlSchema = z
  .object({
    paused: z.boolean(),
    pausedBy: z.string().uuid().nullable(),
    pausedAt: z.iso.datetime().nullable(),
    reason: z.string().max(2000).nullable(),
    abort: z.boolean(),
    updatedAt: z.iso.datetime(),
  })
  .strict();

export type PipelineControl = z.infer<typeof pipelineControlSchema>;

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

export type PipelineControlInput = z.infer<typeof pipelineControlInputSchema>;

// ISS-197 — `recoveryStats` was previously `z.record(z.string(), z.number())`
// but never populated (operator UI showed `{}` for every session). The
// structured shape below feeds the sessions-panel badge
// `"Failed 3x (2 transient, 1 timeout)"` and the WS broadcast
// `session.recoveryChanged`. Failure kinds mirror the classifier v2 enum.
export const failureKindEnum = z.enum([
  'transient',
  'permission',
  'permanent',
  'timeout',
  'unknown',
]);

export const recoveryStatsSchema = z
  .object({
    totalFailures: z.number().int().min(0),
    byKind: z
      .object({
        transient: z.number().int().min(0),
        permission: z.number().int().min(0),
        permanent: z.number().int().min(0),
        timeout: z.number().int().min(0),
      })
      .strict(),
    lastFailureAt: z.iso.datetime(),
    lastFailureKind: failureKindEnum,
    autoRetries: z.number().int().min(0),
  })
  .strict();

export type RecoveryStats = z.infer<typeof recoveryStatsSchema>;

export const DEFAULT_RECOVERY_STATS: RecoveryStats = {
  totalFailures: 0,
  byKind: { transient: 0, permission: 0, permanent: 0, timeout: 0 },
  lastFailureAt: new Date(0).toISOString(),
  lastFailureKind: 'unknown',
  autoRetries: 0,
};

export const pipelineHealthSchema = z
  .object({
    /**
     * @deprecated Use `recoveryStats.autoRetries`. Retained on the row for
     * one release so legacy readers don't break; the retry engine no longer
     * writes to it.
     */
    retryCount: z.number().int().min(0),
    recoveryStats: recoveryStatsSchema,
    lastError: z
      .object({
        message: z.string().max(4000),
        ts: z.iso.datetime(),
        jobId: z.string().uuid().nullable(),
      })
      .nullable(),
    updatedAt: z.iso.datetime(),
  })
  .strict();

export type PipelineHealth = z.infer<typeof pipelineHealthSchema>;

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

export type PipelineHealthInput = z.infer<typeof pipelineHealthInputSchema>;

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
    pausedBy: willPause ? actorId : wasPaused && input.paused === false ? null : prev?.pausedBy ?? null,
    pausedAt: willPause && !wasPaused ? now : input.paused === false ? null : prev?.pausedAt ?? null,
    // Reason describes the active pause — clear it on resume so a stale
    // "manual" note doesn't survive the next pause cycle.
    reason:
      input.reason !== undefined
        ? input.reason
        : input.paused === false
          ? null
          : inheritedReason,
    abort: input.abort ?? prev?.abort ?? false,
    updatedAt: now,
  };
}

// Normalise a legacy or partial pipeline_control row into the canonical shape.
// Returns null when nothing has been written yet.
export function normalisePipelineControl(
  raw: unknown,
): PipelineControl | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const legacyNote = typeof r.note === 'string' ? r.note : null;
  return {
    paused: r.paused === true,
    pausedBy: typeof r.pausedBy === 'string' ? r.pausedBy : null,
    pausedAt: typeof r.pausedAt === 'string' ? r.pausedAt : null,
    reason: typeof r.reason === 'string' ? r.reason : legacyNote,
    abort: r.abort === true,
    updatedAt:
      typeof r.updatedAt === 'string' ? r.updatedAt : new Date(0).toISOString(),
  };
}

export function buildPipelineHealth(
  prev: Partial<PipelineHealth> | null,
  input: PipelineHealthInput,
): PipelineHealth {
  return {
    retryCount: input.retryCount ?? prev?.retryCount ?? 0,
    recoveryStats:
      input.recoveryStats ?? prev?.recoveryStats ?? DEFAULT_RECOVERY_STATS,
    lastError: input.lastError !== undefined ? input.lastError : prev?.lastError ?? null,
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
    : 'unknown';
  const lastAt = typeof r.lastFailureAt === 'string' ? r.lastFailureAt : new Date(0).toISOString();
  return {
    totalFailures: num(r.totalFailures),
    byKind: {
      transient: num(byKindRaw.transient),
      permission: num(byKindRaw.permission),
      permanent: num(byKindRaw.permanent),
      timeout: num(byKindRaw.timeout),
    },
    lastFailureAt: lastAt,
    lastFailureKind,
    autoRetries: num(r.autoRetries),
  };
}
