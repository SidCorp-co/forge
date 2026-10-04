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
] as const;
export type PipelineRefusalCode = (typeof PIPELINE_REFUSAL_CODES)[number];
export const PIPELINE_REFUSAL_STATUSES = {
	ACTIVE_JOB_CONFLICT: 409,
} as const satisfies RefusalStatuses<PipelineRefusalCode>;

/** How long a dispatched deploy may run before its confirmation is overdue. */
export const DEPLOY_CONFIRM_WINDOW_MS = 30 * 60_000;
