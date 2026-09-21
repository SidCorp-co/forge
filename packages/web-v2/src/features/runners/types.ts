import type { HealthKey } from "@/design";

export type RunnerBuildState = "current" | "behind" | "unknown";
export type { ProjectGitAccessView, SshConnTestResult } from "@forge/contracts";

/** A row of `GET /api/me/devices` (owner-scoped). */
export interface DeviceRow {
	id: string;
	name: string;
	platform: "macos" | "linux" | "windows";
	agentVersion: string | null;
	/** The commit this device's last heartbeat said it was built from (ISS-1165). */
	agentCommit: string | null;
	/** Latest published runner version (server-read VERSION), null if none. */
	latestAgentVersion: string | null;
	/** The commit that published release was built from, null if it recorded none. */
	latestAgentCommit: string | null;
	/** The newest commit under `packages/runner` on the default branch, null if unread. */
	mainRunnerHead: string | null;
	/**
	 * This box against the published release, and the published release against the
	 * runner on the default branch. `unknown` is not `current` (ISS-1165).
	 */
	agentBuildState: RunnerBuildState;
	runnerReleaseState: RunnerBuildState;
	/** One sentence naming what was compared and what it found. */
	agentBuildDetail: string;
	/** True when either comparison answered `behind`. */
	agentOutdated: boolean;
	status: "online" | "offline" | "revoked";
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
/**
 * The resident master session core holds for one (device, project), or `null`.
 *
 * A registration and not a pane, so `lastHeartbeatAt` is the only thing that
 * separates a master working now from a box that went quiet (ISS-1118).
 */
export interface ResidentMaster {
	sessionId: string;
	/** The terminal session name, so a reader can match it on the box. */
	name: string;
	lastHeartbeatAt: string | null;
}

export interface ProjectRunner {
	runnerId: string;
	deviceId: string | null;
	deviceName: string | null;
	platform: "macos" | "linux" | "windows" | null;
	deviceStatus: "online" | "offline" | "revoked" | null;
	/** The version this runner's device last reported, or null where it has
	 *  reported none. Read from the joined device — a runner is one binding of
	 *  the agent binary that device runs (ISS-1119). */
	agentVersion: string | null;
	deviceDisabledAt: string | null;
	runnerStatus: string;
	lastError: string | null;
	/** Why the runner is currently limited (rate/usage/auth), or null. */
	limitReason: RunnerLimitReason | null;
	/** ISO reset time for a time-based limit; null for `auth` / no limit. */
	rateLimitedUntil: string | null;
	/** Short human-readable limit detail. */
	limitDetail: string | null;
	repoPath: string | null;
	branch: string | null;
	/** Pool tags; a production binding's `releaseRunnerLabel` names one to prefer. */
	labels: string[];
	lastSeenAt: string | null;
	provisionStatus: ProvisionStatus | null;
	provisionDetail: string | null;
	provisionedAt: string | null;
	/** `undefined` on a core that does not serve the field; `null` is "none". */
	residentMaster?: ResidentMaster | null;
}

/** What every surface says for a version nobody reported. Blank would read as a
 *  device with nothing to say, and the newest published version would be a guess
 *  presented as a fact. */
export const VERSION_NOT_REPORTED = "version not reported";

/** The version chip on a project runner row, labelled as the runner's so it is
 *  never taken for Forge's own. */
export function runnerVersionLabel(agentVersion: string | null | undefined): string {
	const reported = agentVersion?.trim();
	return reported ? `Runner v${reported}` : VERSION_NOT_REPORTED;
}

/** The version line under a device's name in the fleet list. */
export function deviceVersionLabel(agentVersion: string | null | undefined): string {
	const reported = agentVersion?.trim();
	return reported ? `v${reported}` : VERSION_NOT_REPORTED;
}

/** The chip beside a device's version, or null where there is nothing to say. */
export interface DeviceBuildChip {
	label: string;
	title: string;
	tone: "warning" | "muted";
}

/**
 * A box that could not be compared gets a chip of its own rather than none: the
 * health endpoint refuses such a box, and a row that says nothing about it reads
 * as a box with nothing wrong (ISS-1165).
 */
export function deviceBuildChip(device: {
	agentOutdated: boolean;
	agentBuildState: RunnerBuildState;
	agentBuildDetail: string;
}): DeviceBuildChip | null {
	const title = device.agentBuildDetail || "";
	if (device.agentOutdated) {
		return { label: "update pending", title: title || "Update pending", tone: "warning" };
	}
	if (device.agentBuildState === "unknown") {
		return { label: "build unknown", title: title || "This build could not be compared", tone: "muted" };
	}
	return null;
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
	retentionDays?: number | null;
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
