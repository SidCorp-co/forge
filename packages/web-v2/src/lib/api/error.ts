// Ported verbatim from `packages/web/src/lib/api/error.ts` (ISS-288).
import { ApiError } from "./client";

const FRIENDLY_CODES: Record<string, string> = {
	UNAUTHENTICATED: "Your session has expired. Please sign in again.",
	INVALID_TOKEN: "Your session is invalid. Please sign in again.",
	FORBIDDEN: "You do not have access to this resource.",
	ADMIN_ONLY: "Admin access required.",
	EMAIL_NOT_VERIFIED: "Please verify your email before continuing.",
	NOT_FOUND: "Not found.",
	BAD_REQUEST: "Invalid input — please check the fields and try again.",
	CONFLICT: "Conflicts with the current state of the resource.",
	ILLEGAL_TRANSITION:
		"That status change is not allowed from the current state.",
	STALE_TRANSITION:
		"Someone else changed this item while you were editing — refresh and retry.",
	NO_OP: "Already in that state.",
	NOT_IMPLEMENTED: "This action is not implemented yet.",
	INVALID_CREDENTIALS: "Email or password is incorrect.",
	SLUG_TAKEN: "That slug is already taken.",
	ASSIGNEE_NOT_MEMBER: "Assignee must be a project member.",
	INVALID_LABELS: "One or more labels do not belong to this project.",
};

export function formatApiError(err: unknown): string {
	if (err instanceof ApiError) {
		if (err.code && FRIENDLY_CODES[err.code]) return FRIENDLY_CODES[err.code];
		if (err.message) return err.message;
		return `Request failed (${err.status})`;
	}
	if (err instanceof Error) return err.message;
	return "Unknown error";
}

// cm:guard ISS-422 — these codes must stay OUT of `FRIENDLY_CODES`. That map is a static code→string lookup and cannot read `details`, so a pipeline-config rejection routed through it loses the only actionable half it carries: WHICH stage blocked the save. That is the vague toast this function exists to replace.

/**
 * Map a pipeline stage *status* (as it appears in error `details`) to the
 * human-facing auto-stage toggle label shown in the Pipeline settings tab.
 * Mirrors `STEP_TOGGLE_LABELS` in `features/project-settings/types.ts`.
 * Any status outside the 8 toggle stages (STAGE_HAS_ISSUES / DEAD_END_CONFIG
 * can reference others) falls back to its raw status name.
 */
const STAGE_LABELS: Record<string, string> = {
	open: "Auto triage",
	confirmed: "Auto clarify",
	clarified: "Auto plan",
	approved: "Auto code",
	developed: "Auto review",
	testing: "Auto test",
	reopen: "Auto fix",
	released: "Auto release",
};

function stageLabel(status: string): string {
	return STAGE_LABELS[status] ?? status;
}

/** Read a `string[]` field from the untyped `details` blob, defensively. */
function detailStringList(details: unknown, key: string): string[] {
	if (details && typeof details === "object") {
		const value = (details as Record<string, unknown>)[key];
		if (Array.isArray(value)) {
			return value.filter((v): v is string => typeof v === "string");
		}
	}
	return [];
}

function joinStageLabels(statuses: string[]): string {
	return statuses.map(stageLabel).join(", ");
}

/**
 * Format a pipeline-config save rejection into a clear, actionable, stage-naming
 * message. Falls back to {@link formatApiError} for non-ApiError values and any
 * code without a dedicated message (so behaviour never regresses).
 */
// cm:why `zValidator` answers a `superRefine` refusal as `BAD_REQUEST` with `z.flattenError`'s `{ formErrors, fieldErrors }`, so the message the schema wrote — readable, already naming the settings it is about — is sitting in `fieldErrors[<top-level key>]` and is otherwise thrown away behind "Invalid input"
// cm:edge contract -> packages/core/src/pipeline/pipeline-config-schema.ts — a `ctx.addIssue` whose `path` starts with a key NOT listed here renders as the generic BAD_REQUEST string; the two must be extended together or the operator gets "please check the fields" for a rule that named itself
const ZOD_REFUSAL_KEYS = ["poolBacklog", "intakeGate", "mcpServers", "states"];

function zodRefusal(details: unknown): string | null {
	if (!details || typeof details !== "object") return null;
	const fieldErrors = (details as { fieldErrors?: unknown }).fieldErrors;
	if (!fieldErrors || typeof fieldErrors !== "object") return null;
	for (const key of ZOD_REFUSAL_KEYS) {
		const msgs = (fieldErrors as Record<string, unknown>)[key];
		if (Array.isArray(msgs) && typeof msgs[0] === "string") return msgs[0];
	}
	return null;
}

export function formatPipelineConfigError(err: unknown): string {
	if (!(err instanceof ApiError)) return formatApiError(err);

	if (err.code === "BAD_REQUEST") {
		const refusal = zodRefusal(err.details);
		if (refusal) return refusal;
	}

	switch (err.code) {
		// cm:guard pass the server's message THROUGH. A cross-field refusal already names both settings in plain English — that is the whole point of writing it in the schema — and paraphrasing it here is a second copy that drifts silently the moment the rule is edited.
		case "CONFIG_CONFLICT":
			return err.message;
		case "MISSING_SKILL_FOR_ENABLED_STAGE":
		case "AUTO_STAGE_NEEDS_SKILL": {
			const stages = detailStringList(err.details, "stagesMissingSkill");
			if (stages.length === 0) break;
			const labels = joinStageLabels(stages);
			return `Can't save: ${labels} ${stages.length === 1 ? "needs" : "need"} a registered skill before ${stages.length === 1 ? "it" : "they"} can run automatically. Register a skill for ${stages.length === 1 ? "that stage" : "those stages"} (Library) or turn the toggle off.`;
		}
		case "STAGE_HAS_ISSUES": {
			const stages = detailStringList(err.details, "stagesBlocked");
			const blocking = detailStringList(err.details, "blockingIssueIds");
			if (stages.length === 0) break;
			const labels = joinStageLabels(stages);
			const count = blocking.length;
			const issuesPhrase =
				count > 0
					? `${count} issue${count === 1 ? "" : "s"} ${count === 1 ? "is" : "are"} currently at ${count === 1 ? "that stage" : "those stages"}`
					: "issues are currently at those stages";
			return `Can't disable ${labels}: ${issuesPhrase}. Move or close them first.`;
		}
		case "DEAD_END_CONFIG": {
			const stages = detailStringList(err.details, "unreachable");
			if (stages.length === 0) break;
			const labels = joinStageLabels(stages);
			return `These stages would have no forward path: ${labels}. Re-enable one of them or an earlier stage.`;
		}
		case "OPEN_LOCKED_ON":
			return "The Open stage can't be disabled.";
	}

	return formatApiError(err);
}
