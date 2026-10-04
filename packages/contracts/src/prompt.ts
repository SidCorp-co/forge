// The codes a prompt preview refuses under, beside the policy and job-context codes it repeats.

export const PROMPT_REFUSAL_CODES = ["PROMPT_REFUSED", "STATE_NOT_CLAIMABLE"] as const;

export type PromptRefusalCode = (typeof PROMPT_REFUSAL_CODES)[number];
