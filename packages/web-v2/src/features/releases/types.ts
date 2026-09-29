import type { ReleaseRoster } from "./roster";


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
	account: string | null;
	logTail: string | null;
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

export type { ReleaseRoster, ReleaseRosterEntry } from "./roster";

/** `GET /api/projects/:projectId/release-batches/:runId/state`. */
export interface ReleaseRunState {
	runId: string;
	projectId: string;
	runStatus: string;
	roster: ReleaseRoster;
	/** Oldest first, by `startedAt` then `id` — core's own order. */
	attempts: ReleaseAttempt[];
	/** `null` when the project declares no probes, or none that can be read. */
	live: ReleaseLiveState | null;
	verification: "probed" | "unverified" | null;
	bounds: ReleaseBoundsReading;
	/** `null` when the run never announced one. */
	method: ReleaseMethod | null;
	methodUnloaded: boolean;
	/** Who owns the release; `null` on a batch cut before a run session owned one. */
	owner: ReleaseOwner | null;
}

/** `lost` gave the roster back to the gate; `orphaned` lost its owner after a promotion. */
export interface ReleaseOwner {
	state: "awaiting" | "owned" | "lost" | "orphaned";
	since: string;
	deadlineAt: string;
	takenAt: string | null;
	deviceName: string | null;
	sessionId: string | null;
	endedAt: string | null;
	why: string | null;
	refusals: Array<{
		at: string;
		deviceName: string | null;
		reason: string;
	}>;
	/** While it waits: every box serving the project and what stops it, read now. */
	boxes: Array<{
		deviceName: string;
		able: boolean;
		clause: string;
		returnAt: string | null;
	}>;
}
