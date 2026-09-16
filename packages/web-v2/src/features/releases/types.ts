// web-v2 feature module: releases — the wire shape of one release run.
//
// Mirrors `ReleaseRunState` in `packages/core/src/release-batch/state.ts` as it
// arrives over JSON: every `timestamp` column there is an ISO string here, and
// nothing else differs. The core file is the source of truth for the meaning of
// each field; this one exists so the screen cannot read a field core does not
// send.

/** What an attempt was an attempt AT — `RELEASE_ATTEMPT_STAGES` in core. */
export type ReleaseAttemptStage = "promote" | "deploy" | "verify" | "repair";

/**
 * One act a release run made. The agent's half (`account`, `logTail`) and the
 * machine's half (`health`, `identity`, `verdict`, `verdictReason`, `readings`)
 * are separate fields and neither is derived from the other — the screen shows
 * both and never presents one as the other.
 */
export interface ReleaseAttempt {
	id: string;
	runId: string;
	stage: ReleaseAttemptStage;
	/** The agent's own key for this act, unique within the run. */
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
