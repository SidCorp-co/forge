// one declaration of the schedule fire vocabulary (design automation rev 1, steps tick, route,
// skipped and streak; ISS-112): core's schedule_runs CHECKs, the one fire writer, alert A5 and the web
// read the values from here.

export const SCHEDULE_KINDS = [
	"prompt",
	"script",
	"release_batch",
	"sentry_pull",
	"status_report",
	/** A cleanup window (REQ-79 BC-7): starts the project's cleanup run on its own slot. */
	"cleanup",
	/** A daily review (ISS-862): hands the project's master its review brief, a nudge in its pane. */
	"daily_review",
	/** A beta port (ISS-923): core ports forge-beta's issues to their same-slug project here and mirrors their status back. */
	"beta_port",
] as const;
export type ScheduleKind = (typeof SCHEDULE_KINDS)[number];

/** Why a daily review fire reached no master, recorded as its refusal (`schedule_runs.refusal`): missed by name. */
export const DAILY_REVIEW_FIRE_REFUSALS = ["DAILY_REVIEW_NO_MASTER", "DAILY_REVIEW_MASTER_SILENT"] as const;
export type DailyReviewFireRefusal = (typeof DAILY_REVIEW_FIRE_REFUSALS)[number];

/**
 * Where a `beta_port` fire reads forge-beta's address and token: two secrets of the schedule's own
 * project, written with `PUT /api/projects/:id/secrets/integration/forge-beta-url` and
 * `.../integration/forge-beta-token`. Nothing else is read: no env var, no file.
 */
export const BETA_PORT_SECRET_SCOPE = "integration";
export const BETA_PORT_SECRET_NAMES = {
	url: "forge-beta-url",
	token: "forge-beta-token",
} as const;

/** Why a `beta_port` fire did nothing, recorded as its refusal (`schedule_runs.refusal`). */
export const BETA_PORT_FIRE_REFUSALS = [
	"BETA_PORT_SECRET_MISSING",
	"BETA_PORT_BETA_UNREADABLE",
] as const;
export type BetaPortFireRefusal = (typeof BETA_PORT_FIRE_REFUSALS)[number];

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
	"nothing-to-do",
	"gate-refused",
] as const;
export type ScheduleRunSkipReason = (typeof SCHEDULE_RUN_SKIP_REASONS)[number];

export const SCHEDULE_RUN_STREAK_SKIP_REASONS = [
	"no-device",
	"project-not-found",
] as const satisfies readonly ScheduleRunSkipReason[];

/**
 * SCHEDULE_DISPATCH_FAILED: nothing was started (no session, no box). SCHEDULE_RUN_FAILED: a fire
 * that runs in core (a script, a release cut, a Sentry pull) ran and failed; its detail is that
 * run's own error, as the fire records it.
 */
export const SCHEDULE_REFUSAL_CODES = [
	"SCHEDULE_REFUSED",
	"SCHEDULE_DISPATCH_FAILED",
	"SCHEDULE_RUN_FAILED",
] as const;
export type ScheduleRefusalCode = (typeof SCHEDULE_REFUSAL_CODES)[number];

/** Who may change a schedule: its owner with write access; anyone else needs admin, and the save takes it over. */
export function scheduleWritePermission(
	ownerId: string | null,
	actorUserId: string,
): "project.write" | "project.admin" {
	return ownerId !== null && ownerId === actorUserId
		? "project.write"
		: "project.admin";
}
