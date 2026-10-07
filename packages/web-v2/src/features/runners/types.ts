import type { HealthKey } from "@/design";
import { formatElapsed as formatSpan, formatStamp } from "@/lib/utils/format";

export type RunnerBuildState = "current" | "behind" | "unknown";

/** A row of `GET /api/me/devices` (owner-scoped). */
export interface DeviceRow {
	/**
	 * Whether the signed-in user paired this box. Always true on the owner-scoped
	 * list and answered per row on the org one, because rename, turn-off and
	 * revoke are the owner's alone and a control that always 403s is worse than
	 * no control (ISS-1162).
	 */
	ownedByMe: boolean;
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
	/**
	 * This box's declaration gate, `null` where it has never reported one. The
	 * gate admits a dispatch it could not judge rather than stopping the work,
	 * and before this that admission was readable only by typing one command on
	 * the box itself (ISS-1192).
	 */
	gate: DeviceGate | null;
	/**
	 * The binaries this box's panes need and it last said it cannot resolve,
	 * `null` where it has never reported them. Before this the daemon logged it
	 * at pane start and no screen could read it.
	 */
	binaries: DeviceBinaries | null;
	/**
	 * What each filesystem this box writes its runs' scratch into had left at its
	 * last reading, judged by core; `null` where it has never reported one.
	 */
	disk: DeviceDisk | null;
	createdAt: string;
}

/**
 * A row of `GET /api/orgs/:orgId/devices` — the organisation's devices, over the
 * projects this caller can see, whoever paired them (ISS-1162).
 *
 * Narrower than `DeviceRow`: `capabilities` and `gate` are a box's own
 * diagnostics and stay with its owner. `runnerCount` is the bridge between the
 * two nouns — a runner is one (device, project) binding, so one box stands
 * behind several of the runners the Overview counts, and `projectNames` holds
 * one entry per assignment.
 */
export interface OrgDeviceRow
	extends Omit<DeviceRow, "capabilities" | "gate" | "binaries" | "disk"> {
	runnerCount: number;
	projectNames: string[];
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

/** One row of `GET /api/projects/:id/runners` (project-centric, member-scoped). */
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
	/** ISO next try: when core next lets work at this account; null for `auth` / no limit. Never the reset the account printed. */
	rateLimitedUntil: string | null;
	/** Short human-readable limit detail. */
	limitDetail: string | null;
	/** ISO time the account refused; null with no limit. `undefined` on a core that does not serve it. */
	limitRefusedAt?: string | null;
	/** ISO reset the account printed: its claim, never when work resumes; null where it printed none. */
	limitPrintedResetAt?: string | null;
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
	/** This runner's failed reads of the project's job pool (ISS-1234). */
	poolRead?: RunnerPoolRead | null;
}

/** Times are epoch milliseconds, on the box's own clock. */
export interface RunnerPoolRead {
	verdict: "blind" | "intermittent";
	failures: number;
	countIsFloor: boolean;
	windowMs: number;
	unreadSince: number | null;
	consecutive: number;
	recoveredAt: number | null;
	lastFailure: {
		at: number;
		status: number | null;
		what: string;
		reason: string;
	};
	receivedAt: string;
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

/** What a box reported about its own declaration gate. */
export interface DeviceGate {
	verdict: "clear" | "marked" | "failing_open";
	count: number;
	trimmed: boolean;
	perDay: number | null;
	windowMs: number | null;
	sinceLastMs: number | null;
	byReason: Array<{ reason: string; count: number }>;
	/** When core heard this, which is what says whether it is still the box's present condition. */
	receivedAt: string;
}

export interface DeviceGateBanner {
	count: number;
	rate: string;
	window: string;
	reason: string | null;
	/** Present where the report is old enough that it may no longer be true. */
	stale: string | null;
}

/**
 * Past this, a stored report is not the box's present condition. A box that
 * stopped heartbeating leaves its last report standing, and a banner that read
 * it as current would rebuild the very defect this reports (ISS-1192).
 */
const REPORT_FRESH_FOR_MS = 10 * 60 * 1000;

function asSpan(ms: number | null): string {
	if (ms === null) return "an unknown span";
	const mins = Math.round(ms / 60_000);
	if (mins < 60) return `${mins}m`;
	const hours = Math.round(mins / 60);
	if (hours < 48) return `${hours}h`;
	return `${Math.round(hours / 24)}d`;
}

type ReasonCount = DeviceGate["byReason"][number];

/**
 * The largest count, taken rather than assumed. The box sorts its breakdown, but
 * nothing between there and here declares that order, and a banner naming the
 * wrong cause sends an operator at the wrong remedy (ISS-1192).
 */
function commonestReason(by: ReasonCount[]): ReasonCount | undefined {
	return by.reduce<ReasonCount | undefined>((best, r) => {
		if (best === undefined) return r;
		if (r.count !== best.count) return r.count > best.count ? r : best;
		return r.reason < best.reason ? r : best;
	}, undefined);
}

/**
 * The commonest reason with its share of the count. Bare, a reason standing for
 * 141 of 149 reads as the reason for all of them (ISS-1192).
 */
export function gateReasonLine(by: ReasonCount[], count: number): string | null {
	const top = commonestReason(by);
	if (top === undefined) return null;
	if (top.count === count) return `every one of them: ${top.reason}`;
	return `${top.count} of ${count}: ${top.reason}`;
}

/** The banner, or `null` for a box whose gate is deciding. */
export function deviceGateBanner(
	gate: DeviceGate | null,
	now: number = Date.now(),
): DeviceGateBanner | null {
	if (gate?.verdict !== "failing_open") return null;
	const age = now - Date.parse(gate.receivedAt);
	return {
		count: gate.count,
		rate: gate.perDay === null ? "at an unstated rate" : `${Math.round(gate.perDay)}/day`,
		window: asSpan(gate.windowMs),
		reason: gateReasonLine(gate.byReason, gate.count),
		stale:
			Number.isNaN(age) || age <= REPORT_FRESH_FOR_MS
				? null
				: `last reported ${asSpan(age)} ago, so this may no longer be true`,
	};
}

/** What a box reported about the binaries its panes need. */
export interface DeviceBinaries {
	missing: Array<{ name: string; detail: string }>;
	/** When core heard this, which is what says whether it is still the box's present condition. */
	receivedAt: string;
}

/** What a device screen says about its pane binaries. */
export interface DeviceBinariesRead {
	/** `unreported` is a box whose build sends no report, never one that resolves everything. */
	state: "unreported" | "resolved" | "missing";
	missing: DeviceBinaries["missing"];
	/** Present where the report is old enough that it may no longer be true. */
	stale: string | null;
}

export function deviceBinariesRead(
	binaries: DeviceBinaries | null,
	now: number = Date.now(),
): DeviceBinariesRead {
	if (binaries === null) return { state: "unreported", missing: [], stale: null };
	const age = now - Date.parse(binaries.receivedAt);
	return {
		state: binaries.missing.length > 0 ? "missing" : "resolved",
		missing: binaries.missing,
		stale:
			Number.isNaN(age) || age <= REPORT_FRESH_FOR_MS
				? null
				: `last reported ${asSpan(age)} ago, so this may no longer be true`,
	};
}

export type DiskVerdict = "clear" | "unmeasurable" | "tight" | "critical";

/** One scratch root as core judged it: the box's figures, or why it had none. */
export interface DiskRootRead {
	root: string;
	bytesFree?: number;
	bytesTotal?: number;
	inodesFree?: number;
	inodesTotal?: number;
	refused?: string;
	bytesFreePercent: number | null;
	inodesFreePercent: number | null;
	verdict: DiskVerdict;
	axis: "bytes" | "inodes" | null;
}

export interface DeviceDisk {
	receivedAt: string;
	verdict: DiskVerdict;
	roots: DiskRootRead[];
	tightFreePercent: number;
	criticalFreePercent: number;
}

/** One root as a line: both axes, so the one that did not cross is read beside the one that did. */
export function diskRootLine(r: DiskRootRead): string {
	if (r.refused !== undefined) return `no reading: ${r.refused}`;
	const bytes =
		r.bytesFreePercent === null
			? "bytes: no total stated"
			: `${r.bytesFreePercent}% bytes free (${binarySize(r.bytesFree ?? 0)} of ${binarySize(r.bytesTotal ?? 0)})`;
	const inodes =
		r.inodesFreePercent === null
			? "inodes: no total stated"
			: `${r.inodesFreePercent}% inodes free (${(r.inodesFree ?? 0).toLocaleString()} of ${(r.inodesTotal ?? 0).toLocaleString()})`;
	return `${bytes} · ${inodes}`;
}

function binarySize(bytes: number): string {
	const units = ["E", "P", "T", "G", "M", "K"] as const;
	for (const [i, unit] of units.entries()) {
		const scale = 1024 ** (units.length - i);
		if (bytes >= scale) return `${(bytes / scale).toFixed(1)}${unit}`;
	}
	return `${bytes}B`;
}

/** Where the disk report is old enough that it may no longer be the box's present condition. */
export function deviceDiskStale(disk: DeviceDisk, now: number = Date.now()): string | null {
	const age = now - Date.parse(disk.receivedAt);
	return Number.isNaN(age) || age <= REPORT_FRESH_FOR_MS
		? null
		: `last reported ${asSpan(age)} ago, so this may no longer be true`;
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

export const PROVISION_STEPS: ProvisionStatus[] = [
	"queued",
	"cloning",
	"syncing_skills",
	"writing_mcp",
	"ready",
];

export const PROVISION_LABEL: Record<ProvisionStatus, string> = {
	queued: "Queued",
	cloning: "Cloning repo",
	syncing_skills: "Syncing skills",
	writing_mcp: "Writing MCP config",
	ready: "Ready",
	needs_manual_setup: "Needs manual setup",
	failed: "Failed",
};

export function provisionHealth(status: ProvisionStatus | null): HealthKey {
	switch (status) {
		case "ready":
			return "healthy";
		case "failed":
			return "down";
		case "needs_manual_setup":
			return "attention";
		default:
			return "idle";
	}
}

/** A device's status is a runner status that is never `disabled`. */
export const deviceHealth: (status: DeviceRow["status"]) => HealthKey = runnerHealth;

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
	/** Whether the runner is held now: its next try is still ahead, or it is an auth failure. */
	active: boolean;
	/** e.g. "refused 12m ago"; null where core kept no refusal time. */
	refusedText: string | null;
	/** e.g. "next try in 3m" / "next try due"; null for auth, which a person fixes. */
	nextTryText: string | null;
	/** The reset the account printed, named as its claim; null where it printed none. */
	printedText: string | null;
	detail: string | null;
}

// ISS-276 / FB-87: the account printed 19:30Z and answered at 16:42Z. What the account printed is
// its claim and is said as one; the time shown as when work is tried again is core's next try.
export function runnerLimitDisplay(
	runner: Pick<ProjectRunner, "limitReason" | "rateLimitedUntil" | "limitDetail" | "limitRefusedAt" | "limitPrintedResetAt">,
	now: number = Date.now(),
): RunnerLimitDisplay | null {
	if (!runner.limitReason) return null;
	const reason = runner.limitReason;
	const nextTryMs = runner.rateLimitedUntil ? Date.parse(runner.rateLimitedUntil) : null;
	const refusedMs = runner.limitRefusedAt ? Date.parse(runner.limitRefusedAt) : null;
	return {
		reason,
		label: LIMIT_LABEL[reason],
		health: reason === "auth" ? "down" : "attention",
		active: nextTryMs !== null ? nextTryMs > now : reason === "auth",
		refusedText: refusedMs === null ? null : `refused ${formatSpan(now - refusedMs)} ago`,
		nextTryText: nextTryMs === null ? null : nextTryMs > now ? `next try in ${formatSpan(nextTryMs - now)}` : "next try due",
		printedText: runner.limitPrintedResetAt
			? `The account said it resets at ${formatStamp(runner.limitPrintedResetAt)}: its claim, not when work resumes.`
			: null,
		detail: runner.limitDetail,
	};
}

/** The badge's words: the label, then when it was refused and when it is tried again. */
export function runnerLimitLine(limit: RunnerLimitDisplay): string {
	return [limit.label, limit.refusedText, limit.nextTryText].filter((x): x is string => !!x).join(" · ");
}
