// The codes a job is refused by, in the refusal envelope.

export const JOB_REFUSAL_CODES = [
	"JOB_REFUSED",
	"JOB_NOT_QUEUED",
	"JOB_TERMINATED",
	"INVALID_STATE",
	"NOT_CANCELLABLE",
	"NOT_HELD",
	"POOL_JOB_NO_PROMPT",
	"JOB_CONTEXT_REFUSED",
	"CONTRACT_CONTEXT_UNLOADABLE",
	"ARTIFACT_CONTEXT_UNLOADABLE",
] as const;

export type JobRefusalCode = (typeof JOB_REFUSAL_CODES)[number];

/** Payload key carrying the hold bookkeeping on the successor row. */
export const HOLD_PAYLOAD_KEY = "__hold";

export interface HoldState {
	reason: string;
	heldAt: string;
	/** False once this lineage has already spent its single auto-release. */
	autoRelease: boolean;
}

/** Reasons whose clearance the hold sweep can VERIFY before re-queueing, by re-running the check that failed. */
export const CONDITION_CHECKED_REASONS: ReadonlySet<string> = new Set(["all_devices_exhausted"]);

/** Reasons with nothing to re-check: waiting IS the whole remedy, so the hold simply retries after a recheck interval. */
export const TIME_CHECKED_REASONS: ReadonlySet<string> = new Set(["verify_unavailable"]);

/** Every reason that may auto-release. Derived, never hand-listed — a reason has to pick a lane above to get in. */
export const AUTO_RELEASE_REASONS: ReadonlySet<string> = new Set([
	...CONDITION_CHECKED_REASONS,
	...TIME_CHECKED_REASONS,
]);

function holdResumesItself(reason: string | null | undefined): boolean {
	return reason !== null && reason !== undefined && AUTO_RELEASE_REASONS.has(reason);
}

/**
 * Whether a held job releases itself: a self-clearing reason on a lineage that has not spent its
 * one auto-release. The release sweep acts on it, and every surface that describes a held job
 * asks it with the job's own hold state, so no copy promises a resume the sweep will not perform.
 */
export function holdReleasesItself(hold: HoldState | null, failureReason: string | null = null): boolean {
	return hold ? hold.autoRelease && holdResumesItself(hold.reason) : holdResumesItself(failureReason);
}

export function readHoldState(payload: unknown): HoldState | null {
	if (!payload || typeof payload !== "object") return null;
	const raw = (payload as Record<string, unknown>)[HOLD_PAYLOAD_KEY];
	if (!raw || typeof raw !== "object") return null;
	const { reason, heldAt, autoRelease } = raw as Record<string, unknown>;
	if (typeof reason !== "string" || typeof heldAt !== "string") return null;
	return { reason, heldAt, autoRelease: autoRelease === true };
}

/** Full device sweeps before the retry chain gives up and the caller parks the issue at `needs_info`. */
export const RETRY_MAX_ROUNDS = 10;

/**
 * Round-robin rotation state carried on `payload[AUTO_RETRY_PAYLOAD_KEY]`.
 *
 *   - `round`  — 1-based sweep counter (1..RETRY_MAX_ROUNDS).
 *   - `target` — device the NEXT attempt should land on (dispatcher pins it).
 *   - `tries`  — attempts already spent on `target` this round.
 *   - `done`   — devices that finished their tries this round (dispatcher
 *                excludes them so the sweep doesn't repeat a device).
 */
export const AUTO_RETRY_PAYLOAD_KEY = "_autoRetry";

export interface AutoRetryPayload {
	round: number;
	target: string | null;
	tries: number;
	done: string[];
	/** When this chain first found NO usable device. Null once one appears. */
	deferredSince?: string | null;
}

/** Always returns a normalized state — never undefined — so callers can read fields without guards.
 *  A first dispatch (no prior state) reads as the round-1 zero state. */
export function readAutoRetryPayload(payload: unknown): AutoRetryPayload {
	const zero: AutoRetryPayload = { round: 1, target: null, tries: 0, done: [], deferredSince: null };
	if (!payload || typeof payload !== "object") return zero;
	const raw = (payload as Record<string, unknown>)[AUTO_RETRY_PAYLOAD_KEY];
	if (!raw || typeof raw !== "object") return zero;
	const r = raw as Partial<AutoRetryPayload>;
	return {
		round: typeof r.round === "number" && r.round >= 1 ? r.round : 1,
		target: typeof r.target === "string" ? r.target : null,
		tries: typeof r.tries === "number" && r.tries >= 0 ? r.tries : 0,
		done: Array.isArray(r.done) ? r.done.filter((x): x is string => typeof x === "string") : [],
		deferredSince: typeof r.deferredSince === "string" ? r.deferredSince : null,
	};
}

/** The code a job the pool cannot run is settled with. */
export const POOL_JOB_NO_PROMPT = "POOL_JOB_NO_PROMPT";

/** Why a job the pool cannot run is refused: the pool runs only the `payload.promptString` a job is minted with. */
export function noPromptMessage(jobType: string): string {
	return (
		`a \`${jobType}\` job carries no prompt, and the job pool runs only the ` +
		"`payload.promptString` a job is minted with — a box given this job hands it back on " +
		"every pass. Mint it with a non-empty `promptString`, or not at all."
	);
}

/** Which block of a job's system preamble a measurement is about. */
export type PreambleBlockId =
	| "pipeline-rules"
	| "tool-reference"
	| "project-config"
	| "policy"
	| "project-context"
	| "forge-facts"
	| "state-block"
	| "contract-context"
	| "artifact-context"
	| "pinned-contract-context"
	| "content-language";

/** One block of a built preamble, measured. */
export interface PreambleBlock {
	id: PreambleBlockId;
	kind: "system" | "user";
	chars: number;
	estTokens: number;
}
