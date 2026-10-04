// Refusal codes the PM door answers in the one envelope (docs/conventions/domain-entities.md).
export const PM_REFUSAL_CODES = ["PM_REFUSED", "DISABLED", "TRIGGER_MASKED", "POOL_JOB_NO_PROMPT"] as const;
export type PmRefusalCode = (typeof PM_REFUSAL_CODES)[number];
