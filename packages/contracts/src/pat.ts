// The refusal vocabulary of minting a personal access token.

export const PAT_REFUSAL_CODES = [
	"PAT_REFUSED",
	"PAT_LIMIT",
	"PAT_NAME_CONFLICT",
	"PAT_NAME_RESERVED",
	"PAT_ACCOUNT_PERMISSION_ON_SCOPED_TOKEN",
] as const;

export type PatRefusalCode = (typeof PAT_REFUSAL_CODES)[number];
