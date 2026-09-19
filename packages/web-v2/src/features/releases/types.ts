
export type ReleaseAttemptStage = "promote" | "deploy" | "verify" | "repair";

export interface ReleaseAttempt {
	id: string;
	runId: string;
	stage: ReleaseAttemptStage;
	idempotencyKey: string;
	commit: string | null;
	/** The provider's handle on what it did — a Coolify deployment uuid, a tag. */
	providerRef: string | null;
	health: "up" | "down" | null;
	identity: string | null;
	verdict: "ok" | "failed" | null;
	verdictReason: string | null;
	readings: string[] | null;
	/** The agent's own account of this act. */
	account: string | null;
	logTail: string | null;
	/** True when the machine cut the tail short. */
	logTailTruncated: boolean;
	/** `null` means nobody has read past the cut. */
	logTailReadAt: string | null;
	logTailReadBy: string | null;
	/** When the intent was recorded — BEFORE the act it describes. */
	startedAt: string;
	/** `null` means the act never reported back. */
	settledAt: string | null;
}

export type ReleaseBoundName = "total" | "stall" | "regression";

export interface ReleaseBoundReading {
	name: ReleaseBoundName;
	crossed: boolean;
	measuredMs: number | null;
	thresholdMs: number | null;
	why: string;
}

export interface ReleaseBoundsReading {
	holding: boolean;
	crossedNames: ReleaseBoundName[];
	bounds: ReleaseBoundReading[];
}

/** What the probes say about production, read at request time. */
export interface ReleaseLiveState {
	health: "up" | "down";
	identity: string | null;
	readings: string[];
	unhealthy: string[];
	unidentified: string[];
	disagreement: string[] | null;
}

export interface ReleaseMethod {
	skill: string;
	loaded: boolean;
	detail: string | null;
	announcedAt: string;
}

export interface ReleaseRosterEntry {
	id: string;
	displayId: string;
	title: string;
	mergedAt: string | null;
	waitingDays: number | null;
	claimedByRunId: string | null;
}

export interface ReleaseRoster {
	gateStatus: string | null;
	channel: string | null;
	releaseRunnerLabel: string | null;
	baseBranch: string | null;
	nextCutAt: string | null;
	issues: ReleaseRosterEntry[];
}

/** `GET /api/projects/:projectId/release-batches/:runId/state`. */
export interface ReleaseRunState {
	runId: string;
	projectId: string;
	runStatus: string;
	roster: ReleaseRoster;
	/** Oldest first, by `startedAt` then `id` — core's own order. */
	attempts: ReleaseAttempt[];
	/** `null` only when the project declares no probes. */
	live: ReleaseLiveState | null;
	bounds: ReleaseBoundsReading;
	/** `null` when the run never announced one — which `finish` refuses. */
	method: ReleaseMethod | null;
	methodUnloaded: boolean;
}
