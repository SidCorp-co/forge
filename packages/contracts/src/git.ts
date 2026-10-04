// Refusal codes the git door answers in the one envelope (docs/conventions/domain-entities.md).
export const GIT_REFUSAL_CODES = ["GIT_REFUSED", "GIT_CONNECTION_INACTIVE"] as const;
export type GitRefusalCode = (typeof GIT_REFUSAL_CODES)[number];
