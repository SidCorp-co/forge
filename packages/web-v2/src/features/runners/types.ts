// web-v2 feature module: runners/devices. Types verified against
// `packages/core/src/devices/routes.ts` (GET /me/devices) and
// `packages/core/src/devices/login-routes.ts` (POST /devices/login/init).
import type { HealthKey } from "@/design";

/** A row of `GET /api/me/devices` (owner-scoped). */
export interface DeviceRow {
	id: string;
	name: string;
	platform: "macos" | "linux" | "windows";
	agentVersion: string | null;
	/** Latest published runner version (server-read VERSION), null if none. */
	latestAgentVersion: string | null;
	/** True when this device's agentVersion lags `latestAgentVersion` (ISS-392). */
	agentOutdated: boolean;
	status: "online" | "offline" | "revoked";
	/**
	 * Operator "turn off" timestamp (reversible, distinct from `revoked`). When
	 * set, the device is ignored by dispatch + chat across every project; null =
	 * on/eligible. Toggle via `PATCH /devices/:id { disabled }`.
	 */
	disabledAt: string | null;
	lastSeenAt: string | null;
	pairedAt: string | null;
	capabilities: unknown;
	/** Non-secret label set when a git push credential was provisioned (ISS-305). */
	gitCredentialRef: string | null;
	createdAt: string;
}

/** `POST /api/devices/login/init` response — a fresh pairing code + verify URL. */
export interface PairingCode {
	pairing_code: string;
	/** Relative verify URL, e.g. `/pair?code=XXX-XXXX`. */
	verify_url: string;
	expires_at: string;
}

/**
 * One row of `GET /api/devices/:id/runners` (owner-scoped) — a (device ×
 * project) runner assignment. `repoPath`/`branch` are this device's per-project
 * checkout; `projectDefaultRepoPath`/`baseBranch` are the project defaults the
 * UI prefills from. Verified against `packages/core/src/devices/routes.ts`.
 */
export interface DeviceRunnerAssignment {
	runnerId: string;
	projectId: string;
	slug: string;
	name: string;
	repoPath: string | null;
	branch: string | null;
	status: string;
	lastSeenAt: string | null;
	projectDefaultRepoPath: string | null;
	baseBranch: string | null;
}

/**
 * Per (device × project) workspace provisioning lifecycle — mirrors core's
 * `runnerProvisionStatuses`. NULL/absent = legacy/not-yet-provisioned.
 */
export type ProvisionStatus =
	| "queued"
	| "cloning"
	| "syncing_skills"
	| "writing_mcp"
	| "ready"
	| "needs_manual_setup"
	| "failed";

/** One row of `GET /api/projects/:id/runners` (project-centric, member-scoped). */
export interface ProjectRunner {
	runnerId: string;
	deviceId: string | null;
	deviceName: string | null;
	platform: "macos" | "linux" | "windows" | null;
	deviceStatus: "online" | "offline" | "revoked" | null;
	/**
	 * Operator "turn off" timestamp on the device (reversible). A disabled
	 * device's runner can still heartbeat (deviceStatus stays "online"), so this
	 * is the only signal that explains why an online-looking runner never
	 * receives jobs — the dispatcher excludes disabled devices. Null = enabled.
	 */
	deviceDisabledAt: string | null;
	runnerStatus: string;
	/** Last health/heartbeat error string, cleared on a healthy heartbeat. */
	lastError: string | null;
	/** Why the runner is currently limited (rate/usage/auth), or null. */
	limitReason: RunnerLimitReason | null;
	/** ISO reset time for a time-based limit; null for `auth` / no limit. */
	rateLimitedUntil: string | null;
	/** Short human-readable limit detail. */
	limitDetail: string | null;
	repoPath: string | null;
	branch: string | null;
	lastSeenAt: string | null;
	provisionStatus: ProvisionStatus | null;
	provisionDetail: string | null;
	provisionedAt: string | null;
}

/** One `runner_events` status transition (from `GET /api/runners/:id/activity`). */
export interface RunnerEvent {
	id: string;
	oldStatus: string | null;
	newStatus: string;
	reason: string | null;
	ts: string;
}

/** One recent agent session that ran on a runner's device. */
export interface RunnerSessionActivity {
	id: string;
	title: string | null;
	status: string;
	failureReason: string | null;
	/** Best-effort last error line from the transcript (RESULT_ERROR / API Error). */
	errorExcerpt: string | null;
	updatedAt: string;
}

/** `GET /api/runners/:id/activity` — status timeline + recent device sessions. */
export interface RunnerActivity {
	events: RunnerEvent[];
	sessions: RunnerSessionActivity[];
}

/** The job a runner is currently executing (from `GET /api/runners/active`). */
export interface ActiveRunnerJob {
	jobId: string;
	/** Pipeline stage (job type): code | review | test | fix | … */
	stage: string | null;
	/** ISO dispatch time — basis for the live elapsed counter. */
	startedAt: string | null;
	issueId: string | null;
	/** Display ref, e.g. "ISS-417"; null for non-issue jobs. */
	issueRef: string | null;
	issueTitle: string | null;
}

/** One runner in the project's active snapshot. `current` is null when idle. */
export interface ActiveRunner {
	runnerId: string;
	name: string;
	status: string;
	lastSeenAt: string | null;
	current: ActiveRunnerJob | null;
}

/** `GET /api/runners/active?projectId=` — live per-runner execution snapshot. */
export interface ActiveRunnersSnapshot {
	runners: ActiveRunner[];
	/** Count with a non-null `current`. */
	busy: number;
	/** Total runners on the project. */
	total: number;
}

/**
 * Format the elapsed time since a job's `startedAt` as a compact `Mm Ss` /
 * `Hh Mm` string for the live "running … · 3m 12s" line. Returns null when no
 * start time is known. `now` is injected so a `useNow(1000)` tick re-renders it.
 */
export function formatElapsed(startedAt: string | null, now: number = Date.now()): string | null {
	if (!startedAt) return null;
	const start = Date.parse(startedAt);
	if (!Number.isFinite(start)) return null;
	const sec = Math.max(0, Math.floor((now - start) / 1000));
	if (sec < 60) return `${sec}s`;
	const min = Math.floor(sec / 60);
	if (min < 60) return `${min}m ${sec % 60}s`;
	const hr = Math.floor(min / 60);
	return `${hr}h ${min % 60}m`;
}

/** `GET /api/projects/:id/git-credential` — non-secret deploy-key status. */
export type GitCredentialView =
	| { configured: false }
	| {
			configured: true;
			source: "forge_generated" | "user_provided";
			publicKey: string;
			fingerprint: string | null;
			createdAt: string;
	  };

/** `POST /api/projects/:id/git-credential/test` — deploy-key reachability probe. */
export type GitCredentialTestResult = {
	ok: boolean;
	code:
		| "authenticated"
		| "auth_denied"
		| "host_unreachable"
		| "not_found"
		| "timeout"
		| "error";
	message: string;
	headSha?: string;
};

/** Ordered provision steps for rendering a stepper. */
export const PROVISION_STEPS: ProvisionStatus[] = [
	"queued",
	"cloning",
	"syncing_skills",
	"writing_mcp",
	"ready",
];

/** Human label per provision status. */
export const PROVISION_LABEL: Record<ProvisionStatus, string> = {
	queued: "Queued",
	cloning: "Cloning repo",
	syncing_skills: "Syncing skills",
	writing_mcp: "Writing MCP config",
	ready: "Ready",
	needs_manual_setup: "Needs manual setup",
	failed: "Failed",
};

/** Map a provision status to a kit health key for dots/badges. */
export function provisionHealth(status: ProvisionStatus | null): HealthKey {
	switch (status) {
		case "ready":
			return "healthy";
		case "failed":
			return "down";
		case "needs_manual_setup":
			return "attention";
		case null:
			return "idle";
		default:
			return "idle";
	}
}

/** Map a device's online/offline/revoked status to a kit health key. */
export function deviceHealth(status: DeviceRow["status"]): HealthKey {
	switch (status) {
		case "online":
			return "healthy";
		case "revoked":
			return "down";
		default:
			return "idle";
	}
}

/** Map a runner's free-form status string to a kit health key. */
export function runnerHealth(status: string): HealthKey {
	switch (status) {
		case "online":
			return "healthy";
		case "revoked":
		case "disabled":
			return "down";
		default:
			return "idle";
	}
}

/** Why a runner is limited — mirrors `runnerLimitReasons` on the core schema. */
export type RunnerLimitReason = "usage_limit" | "rate_limit" | "auth";

/** Short badge label per limit reason. */
const LIMIT_LABEL: Record<RunnerLimitReason, string> = {
	usage_limit: "Usage limit",
	rate_limit: "Rate limited",
	auth: "Auth error",
};

export interface RunnerLimitDisplay {
	reason: RunnerLimitReason;
	label: string;
	/** Health tone — auth (needs a fix) is `down`; timed throttles are `attention`. */
	health: HealthKey;
	/** Whether the limit's reset time is still in the future. */
	active: boolean;
	/** e.g. "resets in 42m" / "reset passed" / null when no reset time. */
	resetText: string | null;
	detail: string | null;
}

/**
 * Derive the limited-state display for a runner, or null when it is not
 * limited. A time-based limit whose `rateLimitedUntil` has already passed is
 * still surfaced (active=false, "reset passed") until the next job clears it,
 * so an operator sees the recent throttle.
 */
export function runnerLimitDisplay(
	runner: Pick<ProjectRunner, "limitReason" | "rateLimitedUntil" | "limitDetail">,
	now: number = Date.now(),
): RunnerLimitDisplay | null {
	if (!runner.limitReason) return null;
	const reason = runner.limitReason;
	const resetMs = runner.rateLimitedUntil ? Date.parse(runner.rateLimitedUntil) : null;
	const active = resetMs !== null ? resetMs > now : reason === "auth";
	return {
		reason,
		label: LIMIT_LABEL[reason],
		health: reason === "auth" ? "down" : "attention",
		active,
		resetText: formatReset(resetMs, now),
		detail: runner.limitDetail,
	};
}

function formatReset(resetMs: number | null, now: number): string | null {
	if (resetMs === null) return null;
	const diff = resetMs - now;
	if (diff <= 0) return "reset passed";
	const mins = Math.round(diff / 60000);
	if (mins < 60) return `resets in ${mins}m`;
	const hours = Math.floor(mins / 60);
	const rem = mins % 60;
	return rem === 0 ? `resets in ${hours}h` : `resets in ${hours}h ${rem}m`;
}
