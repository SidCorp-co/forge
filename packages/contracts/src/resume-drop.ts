/**
 * Why a dispatch that HAD a prior session to continue started from an empty transcript instead.
 *
 * "No prior session existed" is not a member: it is the normal shape of a first attempt and
 * counting it would drown the losses that matter. `ResumeRecord.dropReason === null` with
 * `priorClaudeSessionId === null` is that case. `stage_pool` is history only: rows written before
 * per-state runner pools were deleted (ISS-5) carry it.
 */
export const RESUME_DROP_REASONS = [
	"stage_pool",
	"resume_bound_tokens",
	"resume_bound_reopen_cycles",
	"rotation",
	"failure_action",
	"pin_stale",
] as const;
export type ResumeDropReason = (typeof RESUME_DROP_REASONS)[number];
