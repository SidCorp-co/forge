

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
	verdict: "ok" | "failed" | "unverified" | null;
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

export type { ReleaseRoster, ReleaseRosterEntry } from "./roster";
