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

export const pipelineHealthSchema = z
  .object({
    retryCount: z.number().int().min(0),
    recoveryStats: z.record(z.string(), z.number().int().min(0)),
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
    recoveryStats: z.record(z.string(), z.number().int().min(0)).optional(),
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
  recoveryStats: {},
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
    recoveryStats: input.recoveryStats ?? prev?.recoveryStats ?? {},
    lastError: input.lastError !== undefined ? input.lastError : prev?.lastError ?? null,
    updatedAt: new Date().toISOString(),
  };
}
