import { z } from "zod";

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

export const failureKindEnum = z.enum([
	"code",
	"infra",
	"transient-cc",
	"timeout",
]);

export const recoveryStatsSchema = z
	.object({
		totalFailures: z.number().int().min(0),
		byKind: z
			.object({
				code: z.number().int().min(0),
				infra: z.number().int().min(0),
				"transient-cc": z.number().int().min(0),
				timeout: z.number().int().min(0),
			})
			.strict(),
		lastFailureAt: z.iso.datetime(),
		lastFailureKind: failureKindEnum,
		autoRetries: z.number().int().min(0),
	})
	.strict();

export type RecoveryStats = z.infer<typeof recoveryStatsSchema>;

export const pipelineHealthSchema = z
	.object({
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
