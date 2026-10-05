// The codes the pipeline refuses with, in the one refusal envelope (docs/conventions/domain-entities.md).
import type { RefusalStatuses } from "./refusal.js";

export const PIPELINE_REFUSAL_CODES = [
	"PIPELINE_REFUSED",
	"INTAKE_NOT_MANUAL",
	"PROJECT_ARCHIVED",
	"NOT_AT_ENTRY_STATUS",
	"PIPELINE_RUN_TERMINAL",
	"DEPLOY_ENVIRONMENT_LOCKED",
	"ACTIVE_JOB_CONFLICT",
	"ARGUMENT_REQUIRED",
	"ISSUE_NOT_IN_PROJECT",
	"PIPELINE_RUN_NOT_FOUND",
	"HANDOFF_STEP_MISMATCH",
	"PHASE_NOT_OPEN",
	"PHASE_ATTEMPT_CONFLICT",
	"PHASE_REF_NOT_IN_RUN",
	"NO_MASTER_SERVING",
] as const;
export type PipelineRefusalCode = (typeof PIPELINE_REFUSAL_CODES)[number];
export const PIPELINE_REFUSAL_STATUSES = {
	ACTIVE_JOB_CONFLICT: 409,
	ARGUMENT_REQUIRED: 400,
	ISSUE_NOT_IN_PROJECT: 404,
	PIPELINE_RUN_NOT_FOUND: 404,
	PHASE_NOT_OPEN: 409,
	PHASE_ATTEMPT_CONFLICT: 409,
	NO_MASTER_SERVING: 409,
} as const satisfies RefusalStatuses<PipelineRefusalCode>;

/** How long a dispatched deploy may run before its confirmation is overdue. */
export const DEPLOY_CONFIRM_WINDOW_MS = 30 * 60_000;
