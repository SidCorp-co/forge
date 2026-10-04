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
