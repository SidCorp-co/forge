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

/** One look: what every live binding's probes said, kept as the evidence a finish closes on. */
export interface ReleaseReading {
	id: string;
	takenAt: string;
	takenBy: string;
	bindings: Array<{ bindingId: string; name: string } & ReleaseLiveState>;
	unread: string[];
}

export interface ReleaseMethod {
	skill: string;
	loaded: boolean;
	detail: string | null;
	announcedAt: string;
}

export type { ReleaseRoster, ReleaseRosterEntry } from "./roster";

/** Whether a box has started the release's job, and if not, why not — core's own sentence. */
export type ReleaseStart =
	| { kind: "taken"; at: string; device: string | null }
	| {
			kind: "waiting";
			since: string;
			handedBackAt: string;
			reason: "no-eligible-box" | "no-box" | "eligible-not-taken";
			why: string;
	  }
	| { kind: "claimed"; since: string; why: string }
	| { kind: "handed-back"; at: string; why: string }
	| { kind: "aborted"; at: string; by: string; why: string }
	| { kind: "ended"; status: string; at: string | null; why: string }
	| { kind: "none"; why: string };

export interface ReleaseRunIssue {
	id: string;
	displayId: string;
	title: string;
	status: string;
}

/** `GET /api/projects/:projectId/release-batches/:runId/state`. */
export interface ReleaseRunState {
	runId: string;
	projectId: string;
	runStatus: string;
	/** The release gate as it stands now — not this run's roster. */
	roster: ReleaseRoster;
	/** The issues this run was opened with, each as it stands now. */
	runIssues: ReleaseRunIssue[];
	/** Oldest first, by `startedAt` then `id` — core's own order. */
	attempts: ReleaseAttempt[];
	/** `null` when the project declares no probes, or none that can be read. */
	live: ReleaseLiveState | null;
	readings: { total: number; latest: ReleaseReading[] };
	verification: "probed" | "unverified" | null;
	bounds: ReleaseBoundsReading;
	/** `null` when the run never announced one. */
	method: ReleaseMethod | null;
	methodUnloaded: boolean;
	start: ReleaseStart;
}
