// The codes a job is refused by, in the refusal envelope.

export const JOB_REFUSAL_CODES = [
	"JOB_REFUSED",
	"JOB_NOT_QUEUED",
	"JOB_TERMINATED",
	"INVALID_STATE",
	"NOT_CANCELLABLE",
	"NOT_HELD",
	"POOL_JOB_NO_PROMPT",
	"JOB_TYPE_NOT_MINTABLE",
	"JOB_CONTEXT_REFUSED",
	"CONTRACT_CONTEXT_UNLOADABLE",
	"ARTIFACT_CONTEXT_UNLOADABLE",
] as const;

export type JobRefusalCode = (typeof JOB_REFUSAL_CODES)[number];

/**
 * Why a job type cannot be minted through `POST /api/projects/:id/jobs`. A runner serves a pool job
 * by its prompt alone and never branches on the type, so what decides is who mints the type: core's
 * own flows mint some, and no lane mints the rest any more (the staged lane and the `drive` job).
 */
export const UNMINTABLE_JOB_TYPES = {
	release_batch: "core mints it from the release flow (POST /api/projects/:id/release-batches)",
	onboarding: "core mints it from project onboarding",
	drive: "core no longer mints drive jobs: a master opens a run session over the issue instead",
	triage: "the staged lane that minted it was removed",
	clarify: "the staged lane that minted it was removed",
	plan: "the staged lane that minted it was removed",
	code: "the staged lane that minted it was removed",
	review: "the staged lane that minted it was removed",
	test: "the staged lane that minted it was removed",
	staging: "the staged lane that minted it was removed",
	release: "the staged lane that minted it was removed",
	fix: "the staged lane that minted it was removed",
	smoke: "the staged lane that minted it was removed",
} as const;

/** Payload key carrying the hold bookkeeping on the successor row. */
export const HOLD_PAYLOAD_KEY = "__hold";

export interface HoldState {
	reason: string;
	heldAt: string;
	/** False once this lineage has already spent its single auto-release. */
	autoRelease: boolean;
}

/** Reasons whose clearance the hold sweep can VERIFY before re-queueing, by re-running the check that failed. */
const CONDITION_CHECKED_REASONS: ReadonlySet<string> = new Set(["all_devices_exhausted"]);

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

/**
 * Retries one failure chain may spend before the caller parks the issue at `needs_info`, counted on
 * `jobs.attempts`. A transient failure waits a cooldown between retries; a failover retries at once,
 * so it is given a third of the budget.
 */
export const RETRY_MAX_ATTEMPTS = 30;
export const FAILOVER_MAX_ATTEMPTS = 10;

/**
 * The retry state carried on `payload[AUTO_RETRY_PAYLOAD_KEY]` of a retry job.
 *
 *   - `maxAttempts`   — the budget the chain was retried under.
 *   - `deferredSince` — when the chain first found NO usable device; null once one appears.
 */
export const AUTO_RETRY_PAYLOAD_KEY = "_autoRetry";

export interface AutoRetryPayload {
	maxAttempts: number;
	deferredSince: string | null;
}

/** The retry state a job carries, or null on a job that is not a retry (or predates the budget). */
export function readAutoRetryPayload(payload: unknown): AutoRetryPayload | null {
	if (!payload || typeof payload !== "object") return null;
	const raw = (payload as Record<string, unknown>)[AUTO_RETRY_PAYLOAD_KEY];
	if (!raw || typeof raw !== "object") return null;
	const r = raw as Partial<AutoRetryPayload>;
	if (typeof r.maxAttempts !== "number" || r.maxAttempts < 1) return null;
	return {
		maxAttempts: r.maxAttempts,
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
