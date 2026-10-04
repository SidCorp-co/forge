// The codes the pipeline refuses with, in the one 422 envelope (docs/conventions/domain-entities.md).

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
