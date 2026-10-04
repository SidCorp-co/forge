// cm:why one declaration of the schedule fire vocabulary (design automation rev 1, steps tick, route,
// skipped and streak; ISS-112): core's schedule_runs CHECKs, the one fire writer, alert A5 and the web
// read the values from here.

export const SCHEDULE_KINDS = [
	"prompt",
	"script",
	"release_batch",
	"sentry_pull",
] as const;
export type ScheduleKind = (typeof SCHEDULE_KINDS)[number];

export const SCHEDULE_RUN_TRIGGERS = ["manual", "scheduled"] as const;
export type ScheduleRunTrigger = (typeof SCHEDULE_RUN_TRIGGERS)[number];

export const SCHEDULE_RUN_STATUSES = [
	"success",
	"failed",
	"running",
	"skipped",
] as const;
export type ScheduleRunStatus = (typeof SCHEDULE_RUN_STATUSES)[number];

export const SCHEDULE_RUN_SKIP_REASONS = [
	"no-device",
	"project-not-found",
	"already-applied",
	"nothing-to-do",
	"gate-refused",
] as const;
export type ScheduleRunSkipReason = (typeof SCHEDULE_RUN_SKIP_REASONS)[number];

export const SCHEDULE_RUN_STREAK_SKIP_REASONS = [
	"no-device",
	"project-not-found",
] as const satisfies readonly ScheduleRunSkipReason[];

export const SCHEDULE_REFUSAL_CODES = ["SCHEDULE_REFUSED", "SCHEDULE_DISPATCH_FAILED"] as const;
export type ScheduleRefusalCode = (typeof SCHEDULE_REFUSAL_CODES)[number];
